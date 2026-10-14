// The chooser: picks one move from each wasp's menu. It runs in one of two engines, switchable at runtime:
// - "rules": the deterministic pure-code chooser only. Free, reproducible and fully backtestable.
// - "llm": a hosted model picks, through one adapter per provider (llm/adapters.ts):
//     Gemini, Claude (Anthropic) or OpenAI, with a hard daily USD cap (a worst-case reservation before every call), a
//     per-wasp call interval and snapshot caching; or Jev (TypeSafe AI), whose daily cap is a soft threshold (see
//     decideWithClient). Keys travel only in headers, never in URLs or prompts.
//   Whenever the model has no key, the cap (or a reservation) refuses the call, a call fails, or the model answers off
//   the menu, the code chooser answers instead.
// Every answer says who made it (`source`) and, for code, why (`fallbackReason`), so the engine can record and show it.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type * as SDK from "@typesafe-ai/sdk" with { "resolution-mode": "require" };
import type { Menu } from "./bees/types.js";
import { callLlm, chargedUsd as llmCharged, GEMINI_BASE, inputTokenBound, LlmHttpError, requestBody, worstCaseUsd, type LlmProvider, type LlmRequest } from "./llm/adapters.js";
import { log } from "./log.js";
import { redactString, safeError } from "./redact.js";

// @typesafe-ai/sdk 0.6.0 ships only the CJS build (its ESM export path is missing), so load it via require.
const require = createRequire(import.meta.url);
const { TypeSafeClient, choice, score } = require("@typesafe-ai/sdk") as typeof SDK;

export { GEMINI_BASE, inputTokenBound } from "./llm/adapters.js";
/** Room for a short thinking pass plus the JSON answer; also the worst case the cap check prices in. */
export const LLM_MAX_OUTPUT_TOKENS = 1024;
/** Kept for older imports. */
export const GEMINI_MAX_OUTPUT_TOKENS = LLM_MAX_OUTPUT_TOKENS;

/** Which decision engine is on: the rules alone, or a model (with the rules as its fallback). */
export type DecisionEngine = "rules" | "llm";
/** Every provider the chooser knows. "code" = no model configured. */
export type ChooserProviderId = LlmProvider | "jev" | "code";

export interface JevAsk {
  strategy: string;
  state: Record<string, unknown>;
  menu: Menu;
  convictionLabels: readonly string[];
  /** Who is asking (the wasp id). Paces paid calls per wasp; omitted = one shared pace. */
  key?: string;
  /**
   * Extra context for the model only (knowledge layer: news digest, events, similar past trades, owner notes). Never
   * read by the code chooser, never part of the cache key's market state.
   */
  context?: string;
}

/** Who actually made a call: the model, Jev, the deterministic code chooser, or the rules (one legal hold). */
export type DecisionSource = "gemini" | "claude" | "openai" | "jev" | "code" | "rules";
/**
 * Why the code chooser answered instead of the model:
 * no_key, cap (today's spend reached the cap), reservation (this call's worst case did not fit in what is left of the
 * cap, so it was refused before it was sent), backoff (after recent failures), timeout, error (HTTP or network error),
 * off_menu (the model answered something not on the menu), single_option (one move on the menu, nothing to ask),
 * paced (asked less than the minimum interval ago: keep what you have), engine_rules (the rules engine is selected).
 */
export type FallbackReason = "no_key" | "cap" | "reservation" | "backoff" | "timeout" | "error" | "off_menu" | "single_option" | "paced" | "engine_rules";

export interface JevAnswer {
  ok: true;
  /** Who made this call. "code" = the deterministic code chooser; see fallbackReason. */
  source: DecisionSource;
  fallbackReason?: FallbackReason;
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  /** Rounded expected conviction level, 0..3. */
  conviction: number;
  convictionRaw: number;
  inputTokens: number;
  costUsd: number;
  latencyMs: number;
  model: string;
}

export interface JevFailure {
  ok: false;
  reason: "daily_cap" | "backoff" | "error";
  error?: { code: string; message: string };
  latencyMs: number;
}

export type JevResult = JevAnswer | JevFailure;

/** Anything with the TypeSafe SDK's systemOne shape: the real Jev client, or a fake one in tests and e2e:fake-jev. */
export interface SystemOne {
  systemOne(req: SDK.SystemOneRequest, opts?: SDK.RequestOptions): PromiseLike<SDK.SystemOneResult<SDK.Questions>>;
}

export interface JevOpts {
  /** "rules" = the code chooser only, whatever key is set. Default "llm". */
  engine?: DecisionEngine;
  /** Which remote model the key is for. "code" (or no key) = the deterministic code chooser only. Default "gemini". */
  provider?: ChooserProviderId;
  apiKey: string;
  model: string;
  timeoutMs: number;
  dailyUsdCap: number;
  /** USD per million input (prompt) tokens. */
  usdPerMTok: number;
  /** USD per million output tokens, thinking included. Defaults to usdPerMTok. */
  usdPerMTokOut?: number;
  /** Minimum gap between paid model calls for one wasp; in between, the wasp holds. 0 = every tick. */
  minIntervalMs?: number;
  /** Optional Gemini thinkingConfig.thinkingLevel (omitted when unset). */
  thinkingLevel?: string;
  /** Durable spend ledger (the engine DB): a reservation is written before each paid call and settled after. */
  ledger?: { reserveChooserSpend(ts: number, bee: string, usd: number): number; settleChooserSpend(id: number, usd: number): void };
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Spend already recorded today (restored from the DB on restart). */
  spentTodayUsd?: number;
  client?: SystemOne;
  now?: () => number;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const EXIT_LABELS = ["TAKE_PROFIT", "CLOSE_TREND", "TRIM_HALF", "CUT_LOSS", "BAIL"] as const;
const ADD_LABELS = ["DOUBLE_DOWN", "ADD_TO_WINNER"] as const;
const HOLD_LABELS = ["HOLD", "HOLD_WINNER", "RIDE", "WAIT"] as const;

/**
 * Deterministic pure-code chooser used when there is no key, the daily spend cap (or a reservation) refuses the call,
 * only a single move is on the menu, or the model call fails. It picks from the menu by fixed priorities; it does NOT
 * read the owner's free-text rules (coin restrictions still apply, because they shape the menu, and so does the risk layer).
 */
export function fallbackDecide(ask: JevAsk, latencyMs = 0, reason: FallbackReason = "error"): JevAnswer {
  const labels = Object.keys(ask.menu);
  const me = (ask.state.me ?? {}) as Record<string, unknown>;
  const uplR = typeof me.upl_r === "number" ? me.upl_r : null;

  let chosen = labels[0]!;

  // 1. If a profit-taking or risk-reducing exit is offered and warranted, take it.
  if (labels.includes("TAKE_PROFIT")) {
    chosen = "TAKE_PROFIT";
  } else if (labels.includes("CLOSE_TREND")) {
    chosen = "CLOSE_TREND";
  } else if (labels.includes("TRIM_HALF")) {
    chosen = "TRIM_HALF";
  } else if (labels.includes("CUT_LOSS") && uplR !== null && uplR <= -0.8) {
    chosen = "CUT_LOSS";
  } else if (labels.includes("BAIL") && uplR !== null && uplR < 0) {
    chosen = "BAIL";
  } else {
    // 2. Pyramiding into a proven winner.
    const addPick = ADD_LABELS.find((l) => labels.includes(l));
    if (addPick && (uplR === null || uplR >= 1.0)) {
      chosen = addPick;
    } else {
      // 3. When flat, pick the top-ranked strict open setup.
      const strictOpen = labels.find((l) => {
        const intent = ask.menu[l]?.intent;
        return intent?.kind === "open" && intent.setup === "strict";
      });
      if (strictOpen) {
        chosen = strictOpen;
      } else {
        // 4. Otherwise hold position / wait.
        const holdPick = HOLD_LABELS.find((l) => labels.includes(l));
        if (holdPick) chosen = holdPick;
        else {
          const exitPick = EXIT_LABELS.find((l) => labels.includes(l));
          if (exitPick) chosen = exitPick;
        }
      }
    }
  }

  const n = labels.length;
  const primaryProb = n === 1 ? 1 : 0.85;
  const remProb = n > 1 ? Number(((1 - primaryProb) / (n - 1)).toFixed(4)) : 0;
  const probabilities: Record<string, number> = {};
  for (const l of labels) probabilities[l] = l === chosen ? primaryProb : remProb;

  const maxConv = Math.max(0, ask.convictionLabels.length - 1);
  const conviction = Math.min(maxConv, 2);

  return {
    ok: true,
    source: "code",
    fallbackReason: reason,
    choice: chosen,
    probabilities,
    confidence: primaryProb,
    conviction,
    convictionRaw: conviction,
    inputTokens: 0,
    costUsd: 0,
    latencyMs,
    model: "code-fallback",
  };
}

/** Parse the model's JSON strictly: an object whose `choice` is exactly one of the menu labels, nothing else. */
export function parseChoice(text: string, labels: readonly string[], maxConv: number): { choice: string; confidence: number; conviction: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.choice !== "string" || !labels.includes(o.choice)) return null;
  const confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? Math.max(0.01, Math.min(1, o.confidence)) : 0.8;
  const conviction = typeof o.conviction === "number" && Number.isFinite(o.conviction) ? Math.max(0, Math.min(maxConv, o.conviction)) : Math.min(maxConv, 2);
  return { choice: o.choice, confidence, conviction };
}

/** The menu's first "keep what you have" move, or null. */
const holdLabel = (menu: Menu): string | null => Object.keys(menu).find((l) => menu[l]!.intent.kind === "hold") ?? null;

export class Jev {
  private client?: SystemOne;
  private now: () => number;
  private day: string;
  spentTodayUsd: number;
  private backoffUntil = 0;
  private backoffStep = 0;
  /** First failure of the current outage, for the "chooser down > 5 min" alert. */
  downSince: number | null = null;
  private cache = new Map<string, JevAnswer>();
  private lastCallAt = new Map<string, number>();
  /** Worst-case cost of the paid calls in flight right now (the engine asks for all three bees at once). */
  reservedUsd = 0;
  /** The latest time the code chooser stood in for the model (not counting single-option menus and paced holds). */
  lastFallback: { reason: FallbackReason; at: number } | null = null;
  /** UTC day on which a call was last refused because its reservation did not fit under the cap. */
  private refusedDay: string | null = null;

  constructor(private opts: JevOpts) {
    this.client = buildClient(opts);
    this.now = opts.now ?? Date.now;
    this.day = dayKey(this.now());
    this.spentTodayUsd = opts.spentTodayUsd ?? 0;
  }

  /** The engine in force right now ("rules" or "llm"). */
  get engine(): DecisionEngine {
    return this.opts.engine ?? "llm";
  }

  /** The model provider configured right now ("code" when there is none). */
  get provider(): ChooserProviderId {
    if (!this.opts.apiKey && !this.opts.client) return "code";
    return this.opts.provider ?? "gemini";
  }

  get model(): string {
    return this.opts.model;
  }

  get dailyUsdCap(): number {
    return this.opts.dailyUsdCap;
  }

  /**
   * Switch engine or provider at runtime (dashboard controls). Spend today, reservations in flight and the ledger carry
   * over, so the daily cap still covers the whole day; the snapshot cache, pacing and backoff start fresh.
   */
  reconfigure(next: Partial<Pick<JevOpts, "engine" | "provider" | "apiKey" | "model" | "timeoutMs" | "dailyUsdCap" | "usdPerMTok" | "usdPerMTokOut" | "minIntervalMs" | "thinkingLevel">>): void {
    const providerChanged = next.provider !== undefined && next.provider !== this.opts.provider;
    this.opts = { ...this.opts, ...next };
    if (providerChanged || next.apiKey !== undefined || next.model !== undefined) {
      this.client = this.opts.provider === "jev" ? buildClient({ ...this.opts, client: undefined }) : undefined;
    }
    this.cache.clear();
    this.lastCallAt.clear();
    this.backoffStep = 0;
    this.backoffUntil = 0;
    this.downSince = null;
  }

  get capTripped(): boolean {
    this.rollDay();
    return this.spentTodayUsd >= this.opts.dailyUsdCap;
  }

  /** A call was refused today because the cap had no room for it: from then on the code chooser may be answering. */
  get budgetRefusedToday(): boolean {
    this.rollDay();
    return this.refusedDay === this.day;
  }

  private rollDay() {
    const d = dayKey(this.now());
    if (d !== this.day) {
      this.day = d;
      this.spentTodayUsd = 0;
      this.cache.clear();
    }
  }

  private fail(t0: number) {
    // Back off on every failure (timeouts included), so a dead or slow API costs one timeout per backoff window,
    // not one per tick. 2 s, 4 s ... capped at 15 min.
    this.backoffStep = Math.min(this.backoffStep + 1, 10);
    this.backoffUntil = this.now() + Math.min(15 * 60_000, 1000 * 2 ** this.backoffStep);
    this.downSince ??= t0;
  }

  /**
   * Reserve a paid call's worst case against settled spend PLUS every reservation in flight, in memory and in the
   * durable ledger. null = it does not fit under the cap; the caller answers from code instead.
   */
  private reserve(t0: number, key: string, worstUsd: number): { worstUsd: number; ledgerId?: number } | null {
    this.rollDay();
    if (this.spentTodayUsd + this.reservedUsd + worstUsd > this.opts.dailyUsdCap) {
      this.refusedDay = this.day;
      return null;
    }
    this.reservedUsd += worstUsd;
    return { worstUsd, ledgerId: this.opts.ledger?.reserveChooserSpend(t0, key, worstUsd) };
  }

  /** Release a reservation and book what the call is charged (its worst case when billing is unknown). */
  private settle(h: { worstUsd: number; ledgerId?: number }, chargedUsd: number) {
    this.reservedUsd = Math.max(0, this.reservedUsd - h.worstUsd);
    this.rollDay();
    this.spentTodayUsd += chargedUsd;
    if (h.ledgerId !== undefined) this.opts.ledger!.settleChooserSpend(h.ledgerId, chargedUsd);
  }

  async decide(ask: JevAsk): Promise<JevResult> {
    const r = await this.decideInner(ask);
    if (r.ok && r.source === "code" && r.fallbackReason && r.fallbackReason !== "single_option" && r.fallbackReason !== "paced") {
      this.lastFallback = { reason: r.fallbackReason, at: this.now() };
    }
    return r;
  }

  private async decideInner(ask: JevAsk): Promise<JevResult> {
    const t0 = this.now();
    const labels = Object.keys(ask.menu);
    if (labels.length === 0) {
      return { ok: false, reason: "error", error: { code: "EMPTY_MENU", message: "no valid options" }, latencyMs: 0 };
    }

    // The rules engine: the code chooser decides, no model is asked, nothing is spent.
    if (this.engine === "rules") return fallbackDecide(ask, 0, "engine_rules");

    // Jev, or an injected fake chooser (tests, e2e:fake-jev). Same cap, backoff and fallback rules as the others.
    if (this.client) return this.decideWithClient(ask, labels, t0);

    // Single-option menu (e.g. HOLD only): never waste tokens on a forced single choice.
    if (labels.length === 1) return fallbackDecide(ask, 0, "single_option");

    // Fallback to pure code when there is no key, the daily cap is hit, or in backoff.
    const provider: LlmProvider | null = this.opts.provider === undefined ? "gemini" : this.opts.provider === "gemini" || this.opts.provider === "claude" || this.opts.provider === "openai" ? this.opts.provider : null;
    if (!this.opts.apiKey || !provider) return fallbackDecide(ask, 0, "no_key");
    if (this.capTripped) return fallbackDecide(ask, 0, "cap");
    if (t0 < this.backoffUntil) return fallbackDecide(ask, 0, "backoff");

    // Snapshot + menu deduplication cache so identical market states do not re-bill Gemini.
    const stateNoClock = { ...ask.state, utc: undefined };
    const cacheKey = createHash("sha256")
      .update(JSON.stringify({ s: ask.strategy, st: stateNoClock, m: labels, c: ask.context ?? "" }))
      .digest("hex")
      .slice(0, 24);
    const cached = this.cache.get(cacheKey);
    if (cached) return { ...cached, inputTokens: 0, costUsd: 0, latencyMs: 0 };

    // Cadence: at most one paid call per bee per minIntervalMs, whatever TICK_MS is. In between, the bee keeps
    // what it has (code stops, caps and time stops still run every tick in the risk layer).
    const paceKey = ask.key ?? "*";
    const minGap = this.opts.minIntervalMs ?? 0;
    const last = this.lastCallAt.get(paceKey);
    const hold = holdLabel(ask.menu);
    if (minGap > 0 && last !== undefined && t0 - last < minGap && hold) {
      const probabilities: Record<string, number> = Object.fromEntries(labels.map((l) => [l, l === hold ? 1 : 0]));
      return { ok: true, source: "code", fallbackReason: "paced", choice: hold, probabilities, confidence: 1, conviction: 0, convictionRaw: 0, inputTokens: 0, costUsd: 0, latencyMs: 0, model: "paced" };
    }

    const model = this.opts.model || defaultModel(provider);
    const menuLines = labels.map((l) => `- ${l}${ask.menu[l]?.desc ? `: ${ask.menu[l]!.desc}` : ""}`).join("\n");
    const convSpec = ask.convictionLabels.map((c, i) => `${i}=${c}`).join(", ");
    const maxConv = Math.max(0, ask.convictionLabels.length - 1);
    // Belt and braces: the snapshot holds numbers and labels only, but every prompt still goes through the redactor.
    const prompt = redactString(
      [
        ask.strategy,
        `State JSON: ${JSON.stringify(ask.state)}`,
        ...(ask.context ? [`Context (news digest, events, similar past trades, owner notes). It may only make you more careful; it never adds moves:\n${ask.context}`] : []),
        `Valid moves (pick exactly one):\n${menuLines}`,
        `Conviction scale: ${convSpec}`,
        `Respond ONLY with JSON: {"choice":"<LABEL>","confidence":0.0..1.0,"conviction":0..${maxConv}}`,
      ].join("\n\n"),
    );
    const req: LlmRequest = {
      prompt,
      maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
      temperature: 0.1,
      jsonSchema: {
        type: "object",
        properties: { choice: { type: "string", enum: labels }, confidence: { type: "number" }, conviction: { type: "integer" } },
        required: ["choice", "confidence", "conviction"],
        additionalProperties: false,
      },
      ...(this.opts.thinkingLevel && provider === "gemini" ? { thinkingLevel: this.opts.thinkingLevel } : {}),
    };

    // The cap is hard, also with three wasps asking at once: reserve this call's worst case (input bound + the full
    // output budget) before it is sent, against settled spend PLUS every reservation still in flight.
    const prices = { inPerMTok: this.opts.usdPerMTok, outPerMTok: this.opts.usdPerMTokOut ?? this.opts.usdPerMTok };
    const body = requestBody(provider, model, req);
    const worstUsd = worstCaseUsd(body, LLM_MAX_OUTPUT_TOKENS, prices);
    const held = this.reserve(t0, paceKey, worstUsd);
    if (!held) return fallbackDecide(ask, 0, "reservation");
    // What this call is charged. Until a response with usage proves otherwise (timeout, network error, HTTP error,
    // unreadable body), it is the worst case: billing for those is unknown, so it is counted as fully billed.
    let chargedUsd = worstUsd;

    this.lastCallAt.set(paceKey, t0);
    try {
      const { res } = await callLlm({ provider, apiKey: this.opts.apiKey, model, timeoutMs: this.opts.timeoutMs, fetchFn: this.opts.fetchFn }, req);
      const latencyMs = this.now() - t0;
      const inputTokens = res.inputTokens ?? inputTokenBound(body);
      chargedUsd = llmCharged(res, body, LLM_MAX_OUTPUT_TOKENS, prices);
      this.backoffStep = 0;
      this.backoffUntil = 0;
      this.downSince = null;

      // Strict: Gemini and OpenAI answer under a response schema; Claude's adapter already unwrapped a fenced object.
      const pick = parseChoice(res.text, labels, maxConv);
      if (!pick) {
        log.warn("model answer not on the menu, code fallback", { provider, finishReason: res.finishReason });
        return { ...fallbackDecide(ask, latencyMs, "off_menu"), inputTokens, costUsd: chargedUsd };
      }

      const rem = labels.length > 1 ? Number(((1 - pick.confidence) / (labels.length - 1)).toFixed(4)) : 0;
      const probabilities: Record<string, number> = {};
      for (const l of labels) probabilities[l] = l === pick.choice ? pick.confidence : rem;

      const ans: JevAnswer = {
        ok: true,
        source: provider,
        choice: pick.choice,
        probabilities,
        confidence: pick.confidence,
        conviction: Math.round(pick.conviction),
        convictionRaw: pick.conviction,
        inputTokens,
        costUsd: chargedUsd,
        latencyMs,
        model,
      };
      if (this.cache.size >= 500) this.cache.clear();
      this.cache.set(cacheKey, ans);
      return ans;
    } catch (err) {
      const latencyMs = this.now() - t0;
      this.fail(t0);
      if (err instanceof LlmHttpError) log.warn("model call failed, code fallback", { provider, status: err.status });
      else log.warn("model call failed, code fallback", { provider, err: safeError(err) });
      return { ...fallbackDecide(ask, latencyMs, isTimeout(err) ? "timeout" : "error"), costUsd: chargedUsd };
    } finally {
      // Settle: release the reservation and book the charge, in memory and in the durable ledger.
      this.settle(held, chargedUsd);
    }
  }

  private async decideWithClient(ask: JevAsk, labels: string[], t0: number): Promise<JevResult> {
    if (this.capTripped) return fallbackDecide(ask, 0, "cap");
    if (t0 < this.backoffUntil) return fallbackDecide(ask, 0, "backoff");
    const criteria = Object.fromEntries(labels.map((l) => [l, ask.menu[l]!.desc]));
    const conv = ask.convictionLabels as unknown as readonly [string, string, ...string[]];
    const req = {
      model: this.opts.model,
      state: ask.state as SDK.EntryType,
      questions: {
        action: choice(`${ask.strategy} Pick your next move.`, criteria),
        conviction: score("Signal strength?", conv),
      },
    };
    // Jev's cap is a SOFT threshold, not a hard one. Each call reserves an estimate before it is sent (the request's
    // byte bound at the input rate; Jev bills input tokens only), against settled spend plus every reservation in flight,
    // and the reservation is written to the durable ledger, so concurrent bees and a restart see it. But Jev counts
    // tokens on its own side (its framing included) and a call is booked at what Jev reports, which can be more than
    // the estimate, so a day can end somewhat over the cap: by at most what the calls in flight at the crossing bill
    // above their estimates. A call that fails (timeout, error) is charged its estimate.
    const worstUsd = (inputTokenBound(JSON.stringify(req)) * this.opts.usdPerMTok) / 1e6;
    const held = this.reserve(t0, ask.key ?? "*", worstUsd);
    if (!held) return fallbackDecide(ask, 0, "reservation");
    // Unknown billing (timeout, error) counts as the estimate.
    let chargedUsd = worstUsd;
    try {
      const r = await this.client!.systemOne(req, { timeout: this.opts.timeoutMs, retry: { maxRetries: 0 } });
      const latencyMs = this.now() - t0;
      const a = r.answers.action as SDK.ChoiceResponse;
      const c = r.answers.conviction as SDK.ScoreResponse;
      const inputTokens = r.usage?.input_tokens ?? inputTokenBound(JSON.stringify(req));
      const costUsd = (inputTokens * this.opts.usdPerMTok) / 1e6;
      chargedUsd = costUsd;
      this.backoffStep = 0;
      this.backoffUntil = 0;
      this.downSince = null;
      if (!labels.includes(a.choice)) return { ...fallbackDecide(ask, latencyMs, "off_menu"), inputTokens, costUsd };
      return {
        ok: true,
        source: "jev",
        choice: a.choice,
        probabilities: { ...a.probabilities },
        confidence: a.confidence,
        conviction: Math.max(0, Math.min(conv.length - 1, Math.round(c.score))),
        convictionRaw: c.score,
        inputTokens,
        costUsd,
        latencyMs,
        model: r.model,
      };
    } catch (err) {
      this.fail(t0);
      return { ...fallbackDecide(ask, this.now() - t0, isTimeout(err) ? "timeout" : "error"), costUsd: chargedUsd };
    } finally {
      this.settle(held, chargedUsd);
    }
  }
}

function buildClient(opts: JevOpts): SystemOne | undefined {
  if (opts.client) return opts.client;
  if (opts.provider !== "jev" || !opts.apiKey) return undefined;
  return new TypeSafeClient({
    apiKey: opts.apiKey,
    defaultModel: opts.model,
    timeout: opts.timeoutMs,
    retry: { maxRetries: 0 }, // we back off ourselves; a tick must not wait on SDK retries
    logLevel: "off", // SDK debug logging would print request bodies
  });
}

/** Default model per provider, when none is configured. */
export function defaultModel(p: LlmProvider): string {
  return p === "claude" ? "claude-haiku-5-5" : p === "openai" ? "gpt-5.4-nano" : "gemini-4-argon";
}

const isTimeout = (err: unknown): boolean => {
  const e = err as { name?: string; message?: string; code?: string };
  return /timeout|abort/i.test(`${e?.name ?? ""} ${e?.code ?? ""} ${e?.message ?? ""}`);
};

/** Setup page: one tiny real call proves the Jev key works. Returns an error message, or null when the key is good. */
export async function checkJevKey(apiKey: string, model: string, timeoutMs = 10_000): Promise<string | null> {
  const client = new TypeSafeClient({ apiKey, defaultModel: model, timeout: timeoutMs, retry: { maxRetries: 0 }, logLevel: "off" });
  try {
    await client.systemOne(
      { model, state: { check: "setup" }, questions: { ok: choice("Is this a connection test?", { YES: null, NO: null }) } },
      { timeout: timeoutMs, retry: { maxRetries: 0 } },
    );
    return null;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) return "Jev rejected that key. Copy it again from console.typesafe.ai/keys.";
    const e = safeError(err);
    return `Could not reach Jev (${e.code}: ${e.message})`;
  }
}

/** Setup page: look the Claude model up with the key (a free metadata call, no tokens). null = the key is good. */
export async function checkClaudeKey(apiKey: string, model: string, timeoutMs = 10_000, fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchFn(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return null;
    if (res.status === 401 || res.status === 403) return "Anthropic rejected that key. Copy it again from console.anthropic.com.";
    if (res.status === 404) return `That key cannot see ${model}. Set ANTHROPIC_MODEL to a model your account has.`;
    return `Could not reach the Anthropic API (HTTP ${res.status})`;
  } catch (err) {
    const e = safeError(err);
    return `Could not reach the Anthropic API (${e.code}: ${e.message})`;
  }
}

/**
 * Setup page: look the model up with the key (a free metadata call, no tokens). Returns an error message, or null when
 * the key can see the model. It cannot prove billing: a free-tier key may still be refused when the bees first ask.
 */
export async function checkGeminiKey(apiKey: string, model: string, timeoutMs = 10_000, fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchFn(`${GEMINI_BASE}/${encodeURIComponent(model)}`, {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return null;
    if (res.status === 400 || res.status === 401 || res.status === 403) return "Google rejected that key. Copy it again from AI Studio (aistudio.google.com/apikey).";
    if (res.status === 404) return `That key cannot see ${model}. Argon needs a key from a paid-tier project.`;
    return `Could not reach the Gemini API (HTTP ${res.status})`;
  } catch (err) {
    const e = safeError(err);
    return `Could not reach the Gemini API (${e.code}: ${e.message})`;
  }
}
