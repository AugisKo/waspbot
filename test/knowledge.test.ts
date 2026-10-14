import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { EventCalendar, impactOf, loadEventsFile, parseIcs } from "../src/knowledge/calendar.js";
import { DigestStore, keywordDigest, validateDigest } from "../src/knowledge/digest.js";
import { KnowledgeLayer, type KnowledgeToggles } from "../src/knowledge/layer.js";
import { distance, featuresOf, TradeMemory, type EntryFeatures } from "../src/knowledge/memory.js";
import { OwnerNotes } from "../src/knowledge/notes.js";
import { DailyBudget } from "../src/llm/budget.js";
import { KnowledgeLlm } from "../src/llm/client.js";
import { NewsHub } from "../src/news/hub.js";
import type { NewsItem } from "../src/news/types.js";
import { coin, view } from "./fixtures.js";

const NOW = Date.UTC(2026, 9, 14, 12);
const item = (over: Partial<NewsItem>): NewsItem => ({ id: Math.random().toString(36), source: "rss", publisher: "P", title: "t", url: null, publishedAt: NOW - 3_600_000, coins: [], ...over });
const F = (over: Partial<EntryFeatures> = {}): EntryFeatures => ({ regime: "trend", regimeDir: 1, adx: 30, er: 0.5, rsi14: 60, ret24hPct: 3, atr14Pct: 0.6, fundingZ: 0, volZ: 1, newsSentiment: 0, ...over });

describe("keyword digest", () => {
  it("flags an exploit on the coin itself, not a hack elsewhere", () => {
    const d = keywordDigest("SOL", [item({ title: "Solana DeFi protocol exploited for $20M", coins: ["SOL"] }), item({ title: "Exchange hacked", coins: [] })], NOW);
    expect(d.flags).toEqual(["exploit"]);
    expect(keywordDigest("BTC", [item({ title: "Exchange hacked", coins: [] })], NOW).flags).toEqual([]);
  });

  it("reads direction from words and source sentiment, with low confidence on few items", () => {
    const up = keywordDigest("BTC", [item({ title: "Bitcoin surges to record high on ETF inflows", coins: ["BTC"] })], NOW);
    expect(up.sentiment).toBeGreaterThan(0.5);
    expect(up.confidence).toBeLessThan(0.2);
    const down = keywordDigest("BTC", [item({ title: "neutral", coins: ["BTC"], sentiment: -0.8 })], NOW);
    expect(down.sentiment).toBeCloseTo(-0.8, 5);
  });

  it("validates a model digest strictly", () => {
    const v = validateDigest("BTC", NOW, 3);
    expect(v({ sentiment: 2, confidence: 0.7, flags: ["hack", "made_up"], events: ["x".repeat(200)] })).toMatchObject({ sentiment: 1, flags: ["hack"], by: "llm" });
    expect(v({ sentiment: "up" })).toBeNull();
  });
});

describe("digest store with a model", () => {
  it("asks the model only when there is new news and it is due, within budget, keeping keyword flags", async () => {
    const db = new Db(":memory:");
    let now = NOW;
    const hub = new NewsHub({ db, providers: [], enabled: () => true, coins: () => [], now: () => now });
    hub.store([item({ title: "SOL bridge exploited", coins: ["SOL"] })], now);
    hub.version++;
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(JSON.stringify({ content: [{ type: "text", text: '{"sentiment":-0.6,"confidence":0.8,"flags":[],"events":["Bridge exploit"]}' }], usage: { input_tokens: 500, output_tokens: 40 } }));
    }) as unknown as typeof fetch;
    const budget = new DailyBudget("k", () => 1, db, () => now);
    const llm = new KnowledgeLlm({ provider: "claude", apiKey: "k", model: "m", timeoutMs: 1000, prices: { inPerMTok: 1, outPerMTok: 5 }, budget, fetchFn });
    const store = new DigestStore({ db, hub, llm: () => llm, useLlm: () => true, everyMs: 30 * 60_000, now: () => now });
    await store.refresh(["SOL"]);
    expect(calls).toBe(1);
    expect(store.get("SOL")).toMatchObject({ by: "llm", sentiment: -0.6, flags: ["exploit"], events: ["Bridge exploit"] });
    expect(budget.spentTodayUsd).toBeCloseTo((500 * 1 + 40 * 5) / 1e6, 10);
    now += 60_000;
    await store.refresh(["SOL"]);
    expect(calls).toBe(1); // nothing new, not due
    expect(store.get("SOL")!.by).toBe("llm"); // the model's read is kept between runs
  });

  it("does not call when the budget is spent", async () => {
    const db = new Db(":memory:");
    const hub = new NewsHub({ db, providers: [], enabled: () => true, coins: () => [], now: () => NOW });
    hub.store([item({ title: "BTC news", coins: ["BTC"] })], NOW);
    hub.version++;
    let calls = 0;
    const llm = new KnowledgeLlm({ provider: "claude", apiKey: "k", model: "m", timeoutMs: 1000, prices: { inPerMTok: 1, outPerMTok: 5 }, budget: new DailyBudget("k", () => 0, db, () => NOW), fetchFn: (async () => (calls++, new Response("{}"))) as unknown as typeof fetch });
    const store = new DigestStore({ db, hub, llm: () => llm, useLlm: () => true, everyMs: 1, now: () => NOW });
    await store.refresh(["BTC"]);
    expect(calls).toBe(0);
    expect(store.get("BTC")!.by).toBe("keywords");
  });
});

describe("calendar", () => {
  it("reads the events file with default windows, and validates it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cal-"));
    const p = join(dir, "events.json");
    writeFileSync(p, JSON.stringify({ events: [{ at: "2026-10-14T12:30:00Z", title: "US CPI" }, { at: "2026-10-15T00:00:00Z", title: "SUI unlock", impact: "medium", coins: ["sui"] }] }));
    const ev = loadEventsFile(p);
    expect(ev[0]).toMatchObject({ impact: "high", coins: ["*"], beforeMin: 30, afterMin: 60 });
    expect(ev[1]).toMatchObject({ coins: ["SUI"], beforeMin: 15 });
    writeFileSync(p, JSON.stringify({ events: [{ at: "tomorrow", title: "x" }] }));
    expect(() => loadEventsFile(p)).toThrow(/ISO date-time/);
  });

  it("parses iCalendar and guesses impact", () => {
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261104T180000Z\r\nSUMMARY:FOMC Rate Decision\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261105\r\nSUMMARY:Initial Jobless\r\n  Claims\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(parseIcs(ics)).toEqual([
      { at: Date.UTC(2026, 10, 4, 18), title: "FOMC Rate Decision" },
      { at: Date.UTC(2026, 10, 5), title: "Initial Jobless Claims" },
    ]);
    expect(impactOf("FOMC Rate Decision")).toBe("high");
    expect(impactOf("Initial Jobless Claims")).toBe("medium");
    expect(impactOf("Bank holiday")).toBe("low");
  });

  it("knows which events are active for a coin", () => {
    const c = new EventCalendar({ path: "/nonexistent", now: () => NOW });
    c.set([{ at: NOW + 20 * 60_000, title: "CPI", impact: "high", coins: ["*"], beforeMin: 30, afterMin: 60 }, { at: NOW, title: "SUI unlock", impact: "medium", coins: ["SUI"], beforeMin: 15, afterMin: 30 }]);
    expect(c.active("BTC").map((e) => e.title)).toEqual(["CPI"]);
    expect(c.active("SUI").map((e) => e.title).sort()).toEqual(["CPI", "SUI unlock"]);
    expect(c.active("BTC", NOW - 20 * 60_000)).toEqual([]);
  });
});

describe("trade memory", () => {
  it("finds similar trades and summarises them", () => {
    const m = new TradeMemory(new Db(":memory:"));
    for (let i = 0; i < 20; i++) m.record({ wasp: "bee3", style: "boozy", coin: "SOL", side: "long", openedAt: 0, closedAt: i, pnlUsd: -8, riskUsd: 10, reason: "stop", features: F({ rsi14: 75 }) });
    for (let i = 0; i < 20; i++) m.record({ wasp: "bee3", style: "boozy", coin: "SOL", side: "long", openedAt: 0, closedAt: 100 + i, pnlUsd: 15, riskUsd: 10, reason: "x", features: F({ regime: "range", rsi14: 45, adx: 12, er: 0.1 }) });
    const hot = m.similar("boozy", "long", F({ rsi14: 74 }), 20)!;
    expect(hot).toMatchObject({ n: 20, winRate: 0 });
    expect(hot.avgR).toBeCloseTo(-0.8, 5);
    expect(m.similar("boozy", "short", F())).toBeNull();
    expect(m.count()).toBe(40);
    expect(distance(F(), F({ regime: "range" }))).toBeGreaterThan(distance(F(), F({ rsi14: 70 })));
  });

  it("features come from the coin's stats", () => {
    const s = coin("BTC", { rsi14: 61, regime: { kind: "trend", dir: 1, adx: 28, er: 0.4, volPct: 0.5 } });
    expect(featuresOf(s, 0.3)).toMatchObject({ regime: "trend", adx: 28, rsi14: 61, newsSentiment: 0.3 });
  });
});

describe("owner notes", () => {
  it("reads .md/.txt files, capped", () => {
    const dir = mkdtempSync(join(tmpdir(), "notes-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "Avoid memecoins on Mondays.");
    writeFileSync(join(dir, "b.bin"), "ignored");
    expect(new OwnerNotes({ dir, maxChars: 4000 }).text()).toBe("## a.md\nAvoid memecoins on Mondays.");
    writeFileSync(join(dir, "c.txt"), "x".repeat(5000));
    expect(new OwnerNotes({ dir, maxChars: 600 }).text()).toMatch(/truncated at 600/);
    expect(new OwnerNotes({ dir: "/no/such/dir", maxChars: 600 }).text()).toBe("");
  });
});

describe("knowledge layer verdict", () => {
  const SOL = coin("SOL");
  const V = view([SOL]);
  const on: KnowledgeToggles = { digest: true, calendar: true, memory: true, notes: true };

  function layer(opts: { flags?: string[]; sentiment?: number; confidence?: number; events?: Parameters<EventCalendar["set"]>[0]; losing?: number; lossUsd?: number; toggles?: Partial<KnowledgeToggles> }) {
    const db = new Db(":memory:");
    const hub = new NewsHub({ db, providers: [], enabled: () => true, coins: () => [], now: () => NOW });
    const digests = new DigestStore({ db, hub, llm: () => null, useLlm: () => false, everyMs: 1, now: () => NOW });
    (digests as unknown as { latest: Map<string, unknown> }).latest.set("SOL", { coin: "SOL", at: NOW, sentiment: opts.sentiment ?? 0, confidence: opts.confidence ?? 0.8, flags: opts.flags ?? [], events: [], items: 3, by: "llm" });
    const calendar = new EventCalendar({ path: "/nonexistent", now: () => NOW });
    calendar.set(opts.events ?? []);
    const memory = new TradeMemory(db);
    for (let i = 0; i < (opts.losing ?? 0); i++) memory.record({ wasp: "bee3", style: "boozy", coin: "SOL", side: "long", openedAt: 0, closedAt: i, pnlUsd: -(opts.lossUsd ?? 3), riskUsd: 10, reason: "stop", features: F() });
    return new KnowledgeLayer({ digests, calendar, memory, notes: null, enabled: () => ({ ...on, ...(opts.toggles ?? {}) }), memoryMinSamples: 15, digestMaxAgeMs: 6 * 3_600_000, now: () => NOW });
  }

  it("a severe news flag vetoes longs, a high-impact event vetoes everything", () => {
    expect(layer({ flags: ["exploit"] }).verdict("boozy", V, SOL.instId, "long").veto).toMatch(/exploit/);
    expect(layer({ flags: ["exploit"] }).verdict("boozy", V, SOL.instId, "short")).toMatchObject({ veto: null, sizeMult: 0.5 });
    const ev = [{ at: NOW + 10 * 60_000, title: "FOMC", impact: "high" as const, coins: ["*"], beforeMin: 30, afterMin: 60 }];
    expect(layer({ events: ev }).verdict("boozy", V, SOL.instId, "short").veto).toMatch(/FOMC/);
    expect(layer({ events: ev, toggles: { calendar: false } }).verdict("boozy", V, SOL.instId, "short").veto).toBeNull();
  });

  it("news against the side and losing memory shrink, but never below the floor", () => {
    expect(layer({ sentiment: -0.6 }).verdict("boozy", V, SOL.instId, "long").sizeMult).toBe(0.5);
    expect(layer({ sentiment: -0.6, confidence: 0.2 }).verdict("boozy", V, SOL.instId, "long").sizeMult).toBe(1);
    expect(layer({ losing: 20 }).verdict("boozy", V, SOL.instId, "long").sizeMult).toBe(0.5);
    expect(layer({ losing: 20, lossUsd: 8 }).verdict("boozy", V, SOL.instId, "long").sizeMult).toBe(0.25);
    expect(layer({ losing: 10 }).verdict("boozy", V, SOL.instId, "long").sizeMult).toBe(1); // too few to act on
    const v = layer({ sentiment: -0.6, losing: 20, flags: ["lawsuit"] }).verdict("boozy", V, SOL.instId, "long");
    expect(v.sizeMult).toBe(0.25);
    expect(v.notes.length).toBe(3);
  });

  it("context is short and only holds what is switched on", () => {
    const ev = [{ at: NOW + 2 * 3_600_000, title: "US CPI", impact: "high" as const, coins: ["*"], beforeMin: 30, afterMin: 60 }];
    const l = layer({ sentiment: 0.4, flags: ["outage"], events: ev });
    const c = l.context("boozy", ["SOL"], null);
    expect(c).toMatch(/news SOL: sentiment \+0.40 conf 0.8 flags outage/);
    expect(c).toMatch(/event in 2h: US CPI \(high\)/);
    expect(layer({ sentiment: 0.4, toggles: { digest: false, calendar: false } }).context("boozy", ["SOL"], null)).toBe("");
  });
});
