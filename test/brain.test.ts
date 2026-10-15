// The switchable decision engine: rules vs a model, and the Claude and OpenAI adapters.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { Menu } from "../src/bees/types.js";
import { ControlsStore, handleControls, mergeControls, type Controls } from "../src/controls.js";
import { Db } from "../src/db.js";
import type { PasswordGate } from "../src/gate.js";
import { Jev, type JevAsk } from "../src/jev.js";
import { DailyBudget } from "../src/llm/budget.js";
import { ADAPTERS, adapterFor, extractJsonish, openaiResponses } from "../src/llm/adapters.js";
import { loadConfig } from "../src/config.js";

const menu: Menu = {
  APE_SOL: { desc: "long SOL", intent: { kind: "open", instId: "SOL-USD_UM_XPERP-310404", side: "long", sizeFrac: 1, setup: "strict" } },
  WAIT: { desc: null, intent: { kind: "hold" } },
};
const ask: JevAsk = { strategy: "Momentum.", state: { me: { pos: "flat" } }, menu, convictionLabels: ["none", "low", "mid", "high"], key: "bee3" };
const base = { apiKey: "k", model: "m", timeoutMs: 1000, dailyUsdCap: 3, usdPerMTok: 1, usdPerMTokOut: 5, minIntervalMs: 0 };

function capture(body: unknown) {
  const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchFn = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
  return { sent, fetchFn };
}

describe("rules engine", () => {
  it("never calls a model, whatever key is set, and says so", async () => {
    const c = capture({});
    const j = new Jev({ ...base, provider: "claude", engine: "rules", fetchFn: c.fetchFn });
    const r = await j.decide(ask);
    expect(r).toMatchObject({ ok: true, source: "code", fallbackReason: "engine_rules", costUsd: 0 });
    expect(c.sent).toHaveLength(0);
    expect(j.lastFallback).toBeNull(); // the rules engine is a choice, not a fallback
  });

  it("switches to a model at runtime and back", async () => {
    const c = capture({ content: [{ type: "text", text: '{"choice":"APE_SOL","confidence":0.8,"conviction":2}' }], usage: { input_tokens: 300, output_tokens: 20 } });
    const j = new Jev({ ...base, provider: "claude", engine: "rules", fetchFn: c.fetchFn });
    j.reconfigure({ engine: "llm" });
    expect(await j.decide(ask)).toMatchObject({ source: "claude", choice: "APE_SOL", conviction: 2 });
    j.reconfigure({ engine: "rules" });
    expect(await j.decide(ask)).toMatchObject({ source: "code" });
    expect(c.sent).toHaveLength(1);
  });
});

describe("Claude as the chooser", () => {
  it("sends the key in x-api-key, never the URL, and books real usage", async () => {
    const c = capture({ content: [{ type: "text", text: '```json\n{"choice":"WAIT","confidence":0.7,"conviction":1}\n```' }], usage: { input_tokens: 400, output_tokens: 30 } });
    const j = new Jev({ ...base, provider: "claude", model: "claude-haiku-5-5", apiKey: "sk-ant-secret", fetchFn: c.fetchFn });
    const r = await j.decide({ ...ask, context: "news SOL: sentiment -0.50" });
    expect(r).toMatchObject({ ok: true, source: "claude", choice: "WAIT", model: "claude-haiku-5-5" });
    expect(r.ok && r.costUsd).toBeCloseTo((400 * 1 + 30 * 5) / 1e6, 12);
    const s = c.sent[0]!;
    expect(s.url).toBe("https://api.anthropic.com/v1/messages");
    expect(s.url).not.toContain("sk-ant");
    expect(s.headers["x-api-key"]).toBe("sk-ant-secret");
    expect(s.body.model).toBe("claude-haiku-5-5");
    expect(JSON.stringify(s.body)).toContain("news SOL: sentiment -0.50");
    expect(j.spentTodayUsd).toBeCloseTo((400 + 150) / 1e6, 12);
  });

  it("an off-menu answer falls back to code and is still billed", async () => {
    const c = capture({ content: [{ type: "text", text: '{"choice":"YOLO"}' }], usage: { input_tokens: 400, output_tokens: 30 } });
    const r = await new Jev({ ...base, provider: "claude", fetchFn: c.fetchFn }).decide(ask);
    expect(r).toMatchObject({ source: "code", fallbackReason: "off_menu" });
    expect(r.ok && r.costUsd).toBeGreaterThan(0);
  });

  it("an HTTP error backs off and falls back to code", async () => {
    const fetchFn = (async () => new Response("overloaded", { status: 529 })) as unknown as typeof fetch;
    const j = new Jev({ ...base, provider: "claude", fetchFn });
    expect(await j.decide(ask)).toMatchObject({ source: "code", fallbackReason: "error" });
    expect(await j.decide(ask)).toMatchObject({ source: "code", fallbackReason: "backoff" });
    expect(j.downSince).not.toBeNull();
  });
});

describe("OpenAI as the chooser", () => {
  it("uses chat completions with a JSON schema and a bearer key", async () => {
    const c = capture({ choices: [{ message: { content: '{"choice":"APE_SOL","confidence":0.9,"conviction":3}' }, finish_reason: "stop" }], usage: { prompt_tokens: 350, completion_tokens: 25 } });
    const r = await new Jev({ ...base, provider: "openai", model: "gpt-x", apiKey: "sk-oa", fetchFn: c.fetchFn }).decide(ask);
    expect(r).toMatchObject({ source: "openai", choice: "APE_SOL", conviction: 3 });
    const s = c.sent[0]!;
    expect(s.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(s.headers.authorization).toBe("Bearer sk-oa");
    expect((s.body.response_format as { type: string }).type).toBe("json_schema");
  });
});

describe("adapters", () => {
  it("web search turns on each provider's search tool", () => {
    const req = { prompt: "p", maxOutputTokens: 10, webSearch: true };
    expect(JSON.stringify(ADAPTERS.claude.body("m", req))).toContain("web_search_20250305");
    expect(JSON.stringify(ADAPTERS.gemini.body("m", req))).toContain("google_search");
    expect(adapterFor("openai", true)).toBe(openaiResponses);
    expect(JSON.stringify(openaiResponses.body("m", req))).toContain('"web_search"');
  });

  it("Claude's search answer is the last text block, unwrapped", () => {
    const r = ADAPTERS.claude.parse({ content: [{ type: "text", text: "Let me search." }, { type: "server_tool_use" }, { type: "text", text: 'Here: {"items":[]}' }], usage: { input_tokens: 1, output_tokens: 2, server_tool_use: { web_search_requests: 2 } } });
    expect(r).toMatchObject({ text: '{"items":[]}', webSearches: 2 });
    expect(extractJsonish("```json\n[1]\n```")).toBe("[1]");
  });
});

describe("daily budget", () => {
  it("reserves worst cases, settles real costs, survives a restart and rolls at UTC midnight", () => {
    const db = new Db(":memory:");
    let now = Date.UTC(2026, 9, 14, 23);
    const b = new DailyBudget("k", () => 1, db, () => now);
    expect(b.reserve(0.6)).toBe(true);
    expect(b.reserve(0.6)).toBe(false);
    b.settle(0.6, 0.1);
    expect(b.reserve(0.85)).toBe(true);
    b.settle(0.85, 0.85);
    expect(new DailyBudget("k", () => 1, db, () => now).spentTodayUsd).toBeCloseTo(0.95, 10);
    now += 2 * 3_600_000;
    expect(b.spentTodayUsd).toBe(0);
  });
});

describe("config", () => {
  it("picks a provider per LLM_PROVIDER and refuses one without a key", () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: "sk-ant-xxxxxxxx" }).jev).toMatchObject({ engine: "llm", provider: "claude", model: "claude-haiku-5-5" });
    expect(loadConfig({ ANTHROPIC_API_KEY: "sk-ant-xxxxxxxx", GEMINI_API_KEY: "g-xxxxxxxx" }).jev.provider).toBe("gemini");
    expect(loadConfig({ ANTHROPIC_API_KEY: "sk-ant-xxxxxxxx", GEMINI_API_KEY: "g-xxxxxxxx", LLM_PROVIDER: "claude" }).jev.provider).toBe("claude");
    expect(() => loadConfig({ LLM_PROVIDER: "claude" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(loadConfig({ DECISION_ENGINE: "rules", GEMINI_API_KEY: "g-xxxxxxxx" }).jev.engine).toBe("rules");
  });

  it("live trading runs on the rules engine only when chosen on purpose", () => {
    const live = { DRY_RUN: "false", MODE: "live", LIVE_ACK: "I-ACCEPT-REAL-MONEY-RISK", BEE1_OKX_API_KEY: "a", BEE1_OKX_API_SECRET: "b", BEE1_OKX_API_PASSPHRASE: "c", BEE2_OKX_API_KEY: "a", BEE2_OKX_API_SECRET: "b", BEE2_OKX_API_PASSPHRASE: "c", BEE3_OKX_API_KEY: "a", BEE3_OKX_API_SECRET: "b", BEE3_OKX_API_PASSPHRASE: "c" };
    expect(() => loadConfig(live)).toThrow(/DECISION_ENGINE=rules/);
    expect(loadConfig({ ...live, DECISION_ENGINE: "rules" }).jev.engine).toBe("rules");
  });

  it("the knowledge model is the first provider with a key, or none", () => {
    expect(loadConfig({}).knowledge.llm).toBeNull();
    expect(loadConfig({ GEMINI_API_KEY: "g-xxxxxxxx", ANTHROPIC_API_KEY: "sk-ant-xxxxxxxx" }).knowledge.llm).toMatchObject({ provider: "claude" });
    expect(loadConfig({ GEMINI_API_KEY: "g-xxxxxxxx", KNOWLEDGE_LLM_PROVIDER: "off" }).knowledge.llm).toBeNull();
    expect(loadConfig({ NEWS_WEB_SEARCH: "true" }).news.webSearch).toBe(false); // no model, no web search
  });
});

describe("controls", () => {
  const defaults: Controls = { engine: "rules", provider: null, regimeFilter: true, news: { rss: true, cryptopanic: false, websearch: false, okx: true }, knowledge: { digest: true, calendar: true, memory: true, notes: true } };

  it("merges partial updates, persists them, and notifies", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ctl-")), "controls.json");
    const store = new ControlsStore(path, defaults);
    const seen: string[] = [];
    store.onChange((c, prev) => seen.push(`${prev.engine}->${c.engine}`));
    store.update({ engine: "llm", news: { websearch: true } });
    expect(store.get()).toMatchObject({ engine: "llm", news: { rss: true, websearch: true } });
    expect(new ControlsStore(path, defaults).get().engine).toBe("llm");
    expect(seen).toEqual(["rules->llm"]);
    expect(mergeControls(defaults, { provider: "claude" }).provider).toBe("claude");
  });

  it("POST needs the owner password and a configured provider; GET is public", async () => {
    const store = new ControlsStore(null, defaults);
    let gateResult: "ok" | "bad" = "bad";
    const gate = { check: () => gateResult, set: true } as unknown as PasswordGate;
    const call = async (method: string, path: string, body?: unknown) => {
      const req = Object.assign((async function* () { if (body) yield Buffer.from(JSON.stringify(body)); })(), { method, headers: {} }) as unknown as IncomingMessage;
      let status = 0;
      let out = "";
      const res = { writeHead: (s: number) => (status = s), end: (b: string) => (out = b) } as unknown as ServerResponse;
      await handleControls(req, res, path, { store, gate, available: () => ({ gemini: false, claude: true, openai: false, jev: false }), status: () => ({}), resume: () => false });
      return { status, body: JSON.parse(out) as Record<string, unknown> };
    };
    expect((await call("GET", "/controls")).body).toMatchObject({ controls: { engine: "rules" }, available: { claude: true } });
    expect((await call("POST", "/controls", { engine: "llm" })).status).toBe(401);
    gateResult = "ok";
    expect((await call("POST", "/controls", { provider: "gemini" })).status).toBe(400);
    expect((await call("POST", "/controls", { surprise: 1 })).status).toBe(400);
    expect((await call("POST", "/controls", { engine: "llm", provider: "claude" })).status).toBe(200);
    expect(store.get()).toMatchObject({ engine: "llm", provider: "claude" });
    expect((await call("POST", "/controls/resume")).status).toBe(409);
  });
});
