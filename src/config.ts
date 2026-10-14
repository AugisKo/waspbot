import { z } from "zod";
import { DEFAULT_RSS_FEEDS } from "./news/rss.js";
import { STYLE_INFO, STYLES, type Settings, type StyleId } from "./settings.js";

/** Three bee slots. Each one trades one of the three styles (settings.ts); two bees may share a style. */
export const BEES = ["bee1", "bee2", "bee3"] as const;
export type BeeId = (typeof BEES)[number];
export { STYLES, type StyleId };

/** With no Setup file (settings only from .env), the bees are the original three. */
const DEFAULT_SLOTS: Record<BeeId, StyleId> = { bee1: "bizzy", bee2: "breezy", bee3: "boozy" };
/** Typed as the only acknowledgement that unlocks MODE=live. */
export const LIVE_ACK_PHRASE = "I-ACCEPT-REAL-MONEY-RISK";

export type Mode = "dry" | "demo" | "live";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : /^(1|true|yes|on)$/i.test(v.trim())));
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return def;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a number" });
        return z.NEVER;
      }
      return n;
    });
const str = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : v.trim()));
const opt = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

// Per-style knobs: BIZZY_* = Breakout, BREEZY_* = Trend, BOOZY_* = Momentum. Every bee on that style uses them.
const perStyle = (prefix: string, d: { trades: number; fee: number; spread: number; cooldown: number; stopAtr: number }) => ({
  [`${prefix}_MAX_TRADES_PER_DAY`]: num(d.trades),
  [`${prefix}_FEE_BUDGET_USD_DAY`]: num(d.fee),
  [`${prefix}_SPREAD_GATE_BPS`]: num(d.spread),
  [`${prefix}_COOLDOWN_MINUTES`]: num(d.cooldown),
  [`${prefix}_STOP_ATR_MULT`]: num(d.stopAtr),
});
// Per-bee OKX keys (demo or live only): BEE1_OKX_API_KEY, BEE1_OKX_DEMO_API_KEY, ...
const perSlot = (prefix: string) => ({
  [`${prefix}_OKX_API_KEY`]: opt,
  [`${prefix}_OKX_API_SECRET`]: opt,
  [`${prefix}_OKX_API_PASSPHRASE`]: opt,
  [`${prefix}_OKX_DEMO_API_KEY`]: opt,
  [`${prefix}_OKX_DEMO_API_SECRET`]: opt,
  [`${prefix}_OKX_DEMO_API_PASSPHRASE`]: opt,
});

const EnvSchema = z.object({
  // DRY_RUN=true (the default) forces MODE=dry whatever MODE says. Going to demo or live needs both DRY_RUN=false and MODE set.
  DRY_RUN: bool(true),
  MODE: z.enum(["dry", "demo", "live"]).optional().default("dry"),

  // The chooser. With a Gemini key (here or from Setup) it is Gemini 4 Argon; with only a Jev key it is Jev; with neither,
  // a deterministic code chooser (paper and demo only: MODE=live needs a key). The two keys never mix: a Jev key is never
  // sent to Google, and JEV_* never become the Gemini model or price.
  GEMINI_API_KEY: opt,
  GEMINI_MODEL: str("gemini-4-argon"),
  GEMINI_TIMEOUT_MS: num(3000),
  GEMINI_DAILY_USD_CAP: num(3),
  // Gemini 4 Argon's list price after the launch offer: $4 in / $20 out per million tokens (thinking billed as output).
  // Pricing the cap at the higher price keeps it safe during the offer too.
  GEMINI_USD_PER_MTOK: num(4),
  GEMINI_USD_PER_MTOK_OUT: num(20),
  // At most one paid call per bee per this many ms, whatever TICK_MS is; in between the bee holds.
  GEMINI_MIN_INTERVAL_MS: num(60_000),
  GEMINI_THINKING_LEVEL: opt,
  // Claude (Anthropic) as the chooser. Prices are per million tokens; set them to your model's current list price.
  ANTHROPIC_API_KEY: opt,
  ANTHROPIC_MODEL: str("claude-haiku-5-5"),
  ANTHROPIC_TIMEOUT_MS: num(8000),
  ANTHROPIC_DAILY_USD_CAP: num(3),
  ANTHROPIC_USD_PER_MTOK: num(1),
  ANTHROPIC_USD_PER_MTOK_OUT: num(5),
  ANTHROPIC_MIN_INTERVAL_MS: num(60_000),
  // OpenAI as the chooser (the OPENAI_API_KEY below; it also designs wasps on Setup).
  OPENAI_DECISION_MODEL: str("gpt-5.4-nano"),
  OPENAI_TIMEOUT_MS: num(8000),
  OPENAI_DAILY_USD_CAP: num(3),
  OPENAI_USD_PER_MTOK: num(1),
  OPENAI_USD_PER_MTOK_OUT: num(5),
  OPENAI_MIN_INTERVAL_MS: num(60_000),
  // The decision engine: "rules" (code only, free, backtestable) or "llm" (a model picks, the rules are its fallback).
  // Blank = "llm" when a model key is set, else "rules". Switchable at runtime from the dashboard (owner password).
  DECISION_ENGINE: z.enum(["rules", "llm"]).optional(),
  // Which model when DECISION_ENGINE=llm: auto picks the first one with a key in the order gemini, claude, jev, openai.
  LLM_PROVIDER: z.enum(["auto", "gemini", "claude", "openai", "jev"]).optional().default("auto"),
  TYPESAFE_API_KEY: opt,
  JEV_MODEL: str("jev-1.13.0"),
  JEV_TIMEOUT_MS: num(2000),
  JEV_DAILY_USD_CAP: num(2),
  JEV_USD_PER_MTOK: num(0.042),
  TICK_MS: num(10_000),
  DATA_REFRESH_MS: num(60_000),

  OKX_SITE: z.literal("eea").optional().default("eea"),
  OKX_API_BASE: str("https://eea.okx.com"),
  OKX_CLI_TIMEOUT_MS: num(15_000),

  BEE_START_EQUITY_USD: num(333),
  MAX_LEVERAGE: num(2),
  MARGIN_MODE: z.literal("isolated").optional().default("isolated"),
  MAX_NOTIONAL_USD_PER_BEE: num(700),
  DAILY_LOSS_STOP_PCT: num(8),
  BEE_RETIRE_AT_PCT: num(40),
  // Portfolio rules across all three wasps (risk.ts). The breaker closes everything and holds until the owner resumes.
  PORTFOLIO_MAX_DRAWDOWN_PCT: num(20),
  PORTFOLIO_DAILY_LOSS_PCT: num(6),
  NET_EXPOSURE_MAX_X: num(1),
  SAME_COIN_MAX_WASPS: num(2),
  STALE_FLATTEN_MINUTES: num(10),
  REGIME_FILTER: bool(true),
  LIVE_SIZE_MULTIPLIER: num(0.25),
  LIVE_RAMP_HOURS: num(2),
  MIN_24H_VOL_USD: num(1_000_000),
  ALLOW_NON_CRYPTO: bool(false),
  TAKER_FEE_RATE: num(0.0005),

  BREEZY_MIN_OPEN_PROB: num(0.55),
  BREEZY_MIN_SIZE_USD: num(10),
  BIZZY_SIZE_FRACTION: num(0.5),
  BIZZY_UNIVERSE_SIZE: num(8),
  BIZZY_TIME_STOP_MINUTES: num(240),
  BOOZY_CANDIDATES: num(5),
  // Defaults = Gemini 4 Argon's rules in strategies/*.md (what the original bees run since 2026-10-13).
  ...perStyle("BREEZY", { trades: 2, fee: 0.75, spread: 5, cooldown: 240, stopAtr: 2 }),
  ...perStyle("BIZZY", { trades: 4, fee: 1.2, spread: 5, cooldown: 30, stopAtr: 2 }),
  ...perStyle("BOOZY", { trades: 3, fee: 1.5, spread: 8, cooldown: 60, stopAtr: 2.5 }),
  ...perSlot("BEE1"),
  ...perSlot("BEE2"),
  ...perSlot("BEE3"),
  // Real money needs DRY_RUN=false, MODE=live AND this set to LIVE_ACK_PHRASE. Paper trading needs none of it.
  LIVE_ACK: opt,

  // News sources (each switchable on the dashboard too). docs/KNOWLEDGE.md.
  NEWS_RSS: bool(true),
  NEWS_RSS_FEEDS: opt,
  NEWS_CRYPTOPANIC: bool(true),
  CRYPTOPANIC_TOKEN: opt,
  CRYPTOPANIC_API_URL: opt,
  NEWS_WEB_SEARCH: bool(false),
  NEWS_WEB_SEARCH_EVERY_MIN: num(60),
  NEWS_OKX: bool(true),
  // The knowledge layer: what it may use, and the model that reads the news (its own small daily budget).
  KNOWLEDGE_DIGEST: bool(true),
  KNOWLEDGE_CALENDAR: bool(true),
  KNOWLEDGE_MEMORY: bool(true),
  KNOWLEDGE_NOTES: bool(true),
  KNOWLEDGE_LLM_PROVIDER: z.enum(["auto", "gemini", "claude", "openai", "off"]).optional().default("auto"),
  KNOWLEDGE_LLM_MODEL: opt,
  KNOWLEDGE_DAILY_USD_CAP: num(1),
  CLAUDE_USD_PER_SEARCH: num(0.01),
  DIGEST_EVERY_MIN: num(30),
  MEMORY_MIN_SAMPLES: num(15),
  EVENTS_PATH: str("./data/events.json"),
  EVENTS_ICS_URL: opt,
  NOTES_DIR: str("./data/notes"),
  NOTES_MAX_CHARS: num(4000),
  ENGINE_PORT: num(8080),
  ENGINE_BIND: str("127.0.0.1"),
  // "{mode}" is replaced with dry/demo/live, so each mode keeps its own books.
  DB_PATH: str("./data/bees-{mode}.sqlite"),
  // Written by the Setup page. Anything set in the environment wins over it.
  SETTINGS_PATH: str("./data/settings.json"),
  OPENAI_API_KEY: opt,
  OPENAI_TEXT_MODEL: str("gpt-5.4-nano"),
  OPENAI_IMAGE_MODEL: str("gpt-image-2"),
  // Optional links shown on the dashboard (the "Hosted on Hostinger" chip and the "Get the code" link).
  HOST_LINK: str("https://mrc.fm/beebots"),
  REPO_LINK: str("https://github.com/imikerussell/beebots"),
  // The Hive: the public leaderboard that installs can join (paper only). Reports go to <HIVE_URL>/hive/report.
  HIVE_URL: str("https://beebots.tech"),
  // "Update available" on the dashboard: checks this repo's latest GitHub Release against APP_VERSION (set by the build).
  UPDATE_CHECK: bool(true),
  UPDATE_REPO: str("imikerussell/beebots"),
  APP_VERSION: str("dev"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
  ALERT_WEBHOOK_URL: opt,
  // The Beekeeper (keeper.ts, docs/BEEKEEPER.md). Normally connected from the dashboard (keeper.json); anything set
  // here wins. BEEKEEPER_WEBHOOK_URL is the Zap's Catch Hook; PUBLIC_URL is where the Zap finds this engine.
  BEEKEEPER_WEBHOOK_URL: opt,
  PUBLIC_URL: opt,
  PUBLIC_DOMAIN: opt,
  BEEKEEPER_EVERY_HOURS: opt,
  // Optional ramp-up from this time (ISO or unix ms): hourly for 12 h, every 2 h for 12 h, every 3 h for 12 h.
  BEEKEEPER_RAMP_START: opt,
  // Optional second key for the Beekeeper's door (lab/door.ts), for people who script their own engine. 32+ characters.
  LAB_SECRET: opt,
});

/** "https://host[:port]" from a URL with no path, query or login in it; null for anything else. */
export function originOf(v: string, schemes: readonly string[] = ["http:", "https:"]): string | null {
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  if (!schemes.includes(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== "/" && u.pathname !== "") return null;
  return u.origin;
}

export interface BeeKnobs {
  maxTradesPerDay: number;
  feeBudgetUsdDay: number;
  spreadGateBps: number;
  cooldownMinutes: number;
  stopAtrMult: number;
}

export interface OkxCreds {
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

/** A bee as the dashboard shows it. No secrets. */
export interface SlotProfile {
  style: StyleId;
  name: string;
  tagline: string;
  /** A portrait generated on Setup lives in the data volume. */
  customImage: boolean;
  /** The owner's rules (fed to the chooser) and coin restriction, from Setup. Empty for the original three. */
  rules: string;
  coins: string[];
  /** Made on the Setup page (never shown with the original bees' art). */
  fromSetup: boolean;
}

export interface Config {
  mode: Mode;
  slots: Record<BeeId, SlotProfile>;
  openai: { apiKey?: string; textModel: string; imageModel: string };
  links: { sponsor: string; code: string };
  hive: { url: string };
  update: { enabled: boolean; repo: string; version: string };
  settingsPath: string;
  /**
   * The chooser in force at start. `engine` is "rules" or "llm"; `provider` says which model the key is for ("code" = no
   * key, the deterministic code chooser). The name "jev" stays so the engine, the DB columns and the dashboard keep
   * working. Every provider with a key is also listed in `llm`, so the dashboard can switch between them.
   */
  jev: ChooserConfig & { engine: "rules" | "llm" };
  llm: Partial<Record<Exclude<ChooserProvider, "code">, ChooserConfig>>;
  tickMs: number;
  dataRefreshMs: number;
  okx: { site: "eea"; apiBase: string; cliTimeoutMs: number };
  risk: {
    startEquityUsd: number;
    maxLeverage: number;
    maxNotionalUsdPerBee: number;
    dailyLossStopPct: number;
    retireAtPct: number;
    liveSizeMultiplier: number;
    liveRampHours: number;
    takerFeeRate: number;
    portfolioMaxDrawdownPct: number;
    portfolioDailyLossPct: number;
    netExposureMaxX: number;
    sameCoinMaxWasps: number;
    staleFlattenMs: number;
    regimeFilter: boolean;
  };
  news: {
    rss: boolean;
    rssFeeds: string[];
    cryptopanic: boolean;
    cryptopanicToken?: string;
    cryptopanicUrl?: string;
    webSearch: boolean;
    webSearchEveryMs: number;
    okx: boolean;
  };
  knowledge: {
    digest: boolean;
    calendar: boolean;
    memory: boolean;
    notes: boolean;
    /** The model that reads the news (null = keyword digests only). */
    llm: { provider: "gemini" | "claude" | "openai"; apiKey: string; model: string; timeoutMs: number; inPerMTok: number; outPerMTok: number; perSearch: number } | null;
    dailyUsdCap: number;
    digestEveryMs: number;
    memoryMinSamples: number;
    eventsPath: string;
    eventsIcsUrl?: string;
    notesDir: string;
    notesMaxChars: number;
  };
  universe: { min24hVolUsd: number; allowNonCrypto: boolean };
  /** Knobs per trading style. */
  bees: Record<StyleId, BeeKnobs>;
  breezy: { minOpenProb: number; minSizeUsd: number };
  bizzy: { sizeFraction: number; universeSize: number; timeStopMinutes: number };
  boozy: { candidates: number };
  /** Per-bee OKX credentials for the current mode. Never logged, never sent to the dashboard. */
  creds: Partial<Record<BeeId, OkxCreds>>;
  server: { port: number; bind: string };
  dbPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  alertWebhookUrl?: string;
  /** The Beekeeper's settings from the environment only (keeper.json fills in whatever is unset here). Never logged. */
  keeper: { hookUrl?: string; publicUrl?: string; everyHours?: number; rampStart?: string };
  /** The door's optional second key. Never logged, never sent anywhere. */
  lab: { secret?: string };
}

export type ChooserProvider = "gemini" | "claude" | "openai" | "jev" | "code";

export interface ChooserConfig {
  provider: ChooserProvider;
  apiKey: string;
  model: string;
  timeoutMs: number;
  dailyUsdCap: number;
  usdPerMTok: number;
  usdPerMTokOut: number;
  minIntervalMs: number;
  thinkingLevel?: string;
}

/** What the dashboard and the alerts call the chooser: a short name ("Argon") and a full one ("Gemini 4 Argon"). */
export function chooserName(c: { provider: ChooserProvider; model: string; engine?: "rules" | "llm" }): { short: string; full: string } {
  if (c.engine === "rules") return { short: "Rules", full: "the rules engine" };
  if (c.provider === "jev") return { short: "Jev", full: "Jev" };
  if (c.provider === "code") return { short: "Code", full: "the code chooser" };
  if (c.provider === "claude") return { short: "Claude", full: c.model };
  if (c.provider === "openai") return { short: "OpenAI", full: c.model };
  return /^gemini-4-argon/.test(c.model) ? { short: "Argon", full: "Gemini 4 Argon" } : { short: "Gemini", full: c.model };
}

export class ConfigError extends Error {}

/** Parse and validate the environment (plus the Setup file, if any). Throws ConfigError listing NAMES only, never values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, settings: Settings | null = null): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid settings:\n  ${names.join("\n  ")}`);
  }
  const e = parsed.data as Record<string, unknown> & z.infer<typeof EnvSchema>;
  const mode: Mode = e.DRY_RUN ? "dry" : e.MODE;

  const geminiKey = e.GEMINI_API_KEY ?? settings?.geminiKey;
  const jevKey = e.TYPESAFE_API_KEY ?? settings?.jevKey;
  const claudeKey = e.ANTHROPIC_API_KEY ?? settings?.anthropicKey;
  const openaiKey = e.OPENAI_API_KEY ?? settings?.openaiKey;
  const keys: Record<Exclude<ChooserProvider, "code">, string | undefined> = { gemini: geminiKey, claude: claudeKey, jev: jevKey, openai: openaiKey };
  const missing: string[] = [];
  let provider: ChooserProvider;
  if (e.LLM_PROVIDER === "auto") provider = (["gemini", "claude", "jev"] as const).find((p) => keys[p]) ?? "code";
  else if (keys[e.LLM_PROVIDER]) provider = e.LLM_PROVIDER;
  else {
    provider = "code";
    missing.push(`${{ gemini: "GEMINI_API_KEY", claude: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", jev: "TYPESAFE_API_KEY" }[e.LLM_PROVIDER]} (LLM_PROVIDER=${e.LLM_PROVIDER})`);
  }
  // Default "llm": with no key it answers from the code chooser anyway (fallback "no_key"), so nothing is spent.
  const engine: "rules" | "llm" = e.DECISION_ENGINE ?? settings?.engine ?? "llm";
  // Real money is traded either on a model (with the rules as its fallback) or on the rules engine chosen on purpose.
  // It is never traded on a model that has no key.
  if (mode === "live" && engine === "llm" && provider === "code") missing.push("a model key (GEMINI_API_KEY, ANTHROPIC_API_KEY or TYPESAFE_API_KEY), or DECISION_ENGINE=rules");
  // The spend cap is only as good as the prices it counts with: a zero price makes every call free and a negative one
  // gives money back, so neither may pass. Non-numbers and Infinity were already refused by num(). Names only, never values.
  const money: Array<[string, number, "positive" | "nonnegative"]> = [
    ["GEMINI_DAILY_USD_CAP", e.GEMINI_DAILY_USD_CAP, "nonnegative"],
    ["GEMINI_USD_PER_MTOK", e.GEMINI_USD_PER_MTOK, "positive"],
    ["GEMINI_USD_PER_MTOK_OUT", e.GEMINI_USD_PER_MTOK_OUT, "positive"],
    ["GEMINI_TIMEOUT_MS", e.GEMINI_TIMEOUT_MS, "positive"],
    ["ANTHROPIC_DAILY_USD_CAP", e.ANTHROPIC_DAILY_USD_CAP, "nonnegative"],
    ["ANTHROPIC_USD_PER_MTOK", e.ANTHROPIC_USD_PER_MTOK, "positive"],
    ["ANTHROPIC_USD_PER_MTOK_OUT", e.ANTHROPIC_USD_PER_MTOK_OUT, "positive"],
    ["OPENAI_DAILY_USD_CAP", e.OPENAI_DAILY_USD_CAP, "nonnegative"],
    ["OPENAI_USD_PER_MTOK", e.OPENAI_USD_PER_MTOK, "positive"],
    ["OPENAI_USD_PER_MTOK_OUT", e.OPENAI_USD_PER_MTOK_OUT, "positive"],
    ...(provider === "jev"
      ? ([
          ["JEV_DAILY_USD_CAP", e.JEV_DAILY_USD_CAP, "nonnegative"],
          ["JEV_USD_PER_MTOK", e.JEV_USD_PER_MTOK, "positive"],
          ["JEV_TIMEOUT_MS", e.JEV_TIMEOUT_MS, "positive"],
        ] as Array<[string, number, "positive" | "nonnegative"]>)
      : []),
  ];
  const bad = money.filter(([, v, kind]) => !Number.isFinite(v) || (kind === "positive" ? !(v > 0) : !(v >= 0)));
  if (bad.length) {
    throw new ConfigError(`Invalid settings:\n  ${bad.map(([name, , kind]) => `${name}: must be ${kind === "positive" ? "a number above 0" : "a number, 0 or more"}`).join("\n  ")}`);
  }
  if (mode === "live" && e.LIVE_ACK !== LIVE_ACK_PHRASE) {
    throw new ConfigError(`MODE=live moves real money. Set LIVE_ACK=${LIVE_ACK_PHRASE} to confirm you accept the risk, or go back to DRY_RUN=true.`);
  }

  if (e.MAX_LEVERAGE > 2 || e.MAX_LEVERAGE <= 0) throw new ConfigError("MAX_LEVERAGE must be in (0, 2]. Hard rule 3.");
  if (!(e.PORTFOLIO_MAX_DRAWDOWN_PCT > 0 && e.PORTFOLIO_MAX_DRAWDOWN_PCT <= 100)) throw new ConfigError("PORTFOLIO_MAX_DRAWDOWN_PCT must be in (0, 100]");
  if (!(e.PORTFOLIO_DAILY_LOSS_PCT > 0 && e.PORTFOLIO_DAILY_LOSS_PCT <= 100)) throw new ConfigError("PORTFOLIO_DAILY_LOSS_PCT must be in (0, 100]");
  if (!(e.NET_EXPOSURE_MAX_X > 0 && e.NET_EXPOSURE_MAX_X <= 6)) throw new ConfigError("NET_EXPOSURE_MAX_X must be in (0, 6]");
  if (!(e.SAME_COIN_MAX_WASPS >= 1)) throw new ConfigError("SAME_COIN_MAX_WASPS must be 1 or more");
  if (e.STALE_FLATTEN_MINUTES < 0) throw new ConfigError("STALE_FLATTEN_MINUTES must be 0 (off) or more");
  if (e.BEEKEEPER_WEBHOOK_URL && !/^https:\/\//.test(e.BEEKEEPER_WEBHOOK_URL)) throw new ConfigError("BEEKEEPER_WEBHOOK_URL must start with https://");
  const everyHours = e.BEEKEEPER_EVERY_HOURS === undefined ? undefined : Number(e.BEEKEEPER_EVERY_HOURS);
  if (everyHours !== undefined && !(everyHours >= 0.25)) throw new ConfigError("BEEKEEPER_EVERY_HOURS must be a number, at least 0.25");
  if (e.PUBLIC_URL && !originOf(e.PUBLIC_URL)) throw new ConfigError("PUBLIC_URL must look like https://your-domain or http://your-server-ip (no path)");
  // PUBLIC_DOMAIN is Caddy's site address. When it is a plain domain, the engine's public address follows from it.
  const publicUrl = (e.PUBLIC_URL ? originOf(e.PUBLIC_URL) : null) ?? (e.PUBLIC_DOMAIN && /^[a-z0-9.-]+$/i.test(e.PUBLIC_DOMAIN) ? originOf(`https://${e.PUBLIC_DOMAIN}`) : null) ?? undefined;

  const slots = {} as Record<BeeId, SlotProfile>;
  BEES.forEach((id, i) => {
    const b = settings?.bees[i];
    const style = b?.style ?? DEFAULT_SLOTS[id];
    slots[id] = b
      ? { style, name: b.name, tagline: b.tagline, customImage: b.image, rules: b.rules, coins: b.coins, fromSetup: true }
      : { style, name: STYLE_INFO[style].name, tagline: STYLE_INFO[style].tagline, customImage: false, rules: "", coins: [], fromSetup: false };
  });

  const creds: Partial<Record<BeeId, OkxCreds>> = {};
  if (mode !== "dry") {
    const infix = mode === "demo" ? "OKX_DEMO_API" : "OKX_API";
    for (const bee of BEES) {
      const p = bee.toUpperCase();
      const k = e[`${p}_${infix}_KEY`] as string | undefined;
      const s = e[`${p}_${infix}_SECRET`] as string | undefined;
      const ph = e[`${p}_${infix}_PASSPHRASE`] as string | undefined;
      if (!k) missing.push(`${p}_${infix}_KEY`);
      if (!s) missing.push(`${p}_${infix}_SECRET`);
      if (!ph) missing.push(`${p}_${infix}_PASSPHRASE`);
      if (k && s && ph) creds[bee] = { apiKey: k, secretKey: s, passphrase: ph };
    }
  }
  if (missing.length) {
    throw new ConfigError(`MODE=${mode} needs these settings, which are blank or missing:\n  ${missing.join("\n  ")}`);
  }

  const knobs = (style: StyleId): BeeKnobs => {
    const p = style.toUpperCase();
    const n = (k: string) => e[`${p}_${k}`] as number;
    return {
      maxTradesPerDay: n("MAX_TRADES_PER_DAY"),
      feeBudgetUsdDay: n("FEE_BUDGET_USD_DAY"),
      spreadGateBps: n("SPREAD_GATE_BPS"),
      cooldownMinutes: n("COOLDOWN_MINUTES"),
      stopAtrMult: n("STOP_ATR_MULT"),
    };
  };

  // Every provider's chooser settings. The Gemini entry doubles as the template for "code" (no key).
  const llm: Record<Exclude<ChooserProvider, "code">, ChooserConfig> = {
    gemini: {
      provider: "gemini",
      apiKey: geminiKey ?? "",
      model: e.GEMINI_MODEL,
      timeoutMs: e.GEMINI_TIMEOUT_MS,
      dailyUsdCap: e.GEMINI_DAILY_USD_CAP,
      usdPerMTok: e.GEMINI_USD_PER_MTOK,
      usdPerMTokOut: e.GEMINI_USD_PER_MTOK_OUT,
      minIntervalMs: Math.max(0, e.GEMINI_MIN_INTERVAL_MS),
      ...(e.GEMINI_THINKING_LEVEL ? { thinkingLevel: e.GEMINI_THINKING_LEVEL } : {}),
    },
    claude: {
      provider: "claude",
      apiKey: claudeKey ?? "",
      model: e.ANTHROPIC_MODEL,
      timeoutMs: e.ANTHROPIC_TIMEOUT_MS,
      dailyUsdCap: e.ANTHROPIC_DAILY_USD_CAP,
      usdPerMTok: e.ANTHROPIC_USD_PER_MTOK,
      usdPerMTokOut: e.ANTHROPIC_USD_PER_MTOK_OUT,
      minIntervalMs: Math.max(0, e.ANTHROPIC_MIN_INTERVAL_MS),
    },
    openai: {
      provider: "openai",
      apiKey: openaiKey ?? "",
      model: e.OPENAI_DECISION_MODEL,
      timeoutMs: e.OPENAI_TIMEOUT_MS,
      dailyUsdCap: e.OPENAI_DAILY_USD_CAP,
      usdPerMTok: e.OPENAI_USD_PER_MTOK,
      usdPerMTokOut: e.OPENAI_USD_PER_MTOK_OUT,
      minIntervalMs: Math.max(0, e.OPENAI_MIN_INTERVAL_MS),
    },
    jev: {
      provider: "jev",
      apiKey: jevKey ?? "",
      model: e.JEV_MODEL,
      timeoutMs: e.JEV_TIMEOUT_MS,
      dailyUsdCap: e.JEV_DAILY_USD_CAP,
      usdPerMTok: e.JEV_USD_PER_MTOK,
      usdPerMTokOut: 0, // Jev bills input tokens only
      minIntervalMs: 0, // Jev is cheap enough to ask every tick, as before
    },
  };

  // The knowledge layer's model: the first provider with a key, cheapest default models (KNOWLEDGE_LLM_MODEL overrides).
  const kp = e.KNOWLEDGE_LLM_PROVIDER === "off" ? null : e.KNOWLEDGE_LLM_PROVIDER === "auto" ? ((["claude", "gemini", "openai"] as const).find((p) => keys[p]) ?? null) : keys[e.KNOWLEDGE_LLM_PROVIDER] ? e.KNOWLEDGE_LLM_PROVIDER : null;
  const knowledgeLlm = kp
    ? {
        provider: kp,
        apiKey: keys[kp]!,
        model: e.KNOWLEDGE_LLM_MODEL ?? (kp === "claude" ? e.ANTHROPIC_MODEL : kp === "openai" ? e.OPENAI_DECISION_MODEL : e.GEMINI_MODEL),
        timeoutMs: kp === "claude" ? Math.max(e.ANTHROPIC_TIMEOUT_MS, 30_000) : kp === "openai" ? Math.max(e.OPENAI_TIMEOUT_MS, 30_000) : Math.max(e.GEMINI_TIMEOUT_MS, 30_000),
        inPerMTok: llm[kp].usdPerMTok,
        outPerMTok: llm[kp].usdPerMTokOut,
        perSearch: kp === "claude" ? e.CLAUDE_USD_PER_SEARCH : 0,
      }
    : null;

  return {
    mode,
    slots,
    openai: { apiKey: openaiKey, textModel: e.OPENAI_TEXT_MODEL, imageModel: e.OPENAI_IMAGE_MODEL },
    links: { sponsor: e.HOST_LINK, code: e.REPO_LINK },
    hive: { url: e.HIVE_URL.replace(/\/+$/, "") },
    update: { enabled: e.UPDATE_CHECK, repo: e.UPDATE_REPO, version: e.APP_VERSION },
    settingsPath: e.SETTINGS_PATH,
    jev: { engine, ...(provider === "code" ? { ...llm.gemini!, provider: "code" as const, apiKey: "" } : llm[provider]!) },
    llm: Object.fromEntries(Object.entries(llm).filter(([p]) => keys[p as keyof typeof keys])),
    tickMs: Math.max(1000, e.TICK_MS),
    dataRefreshMs: Math.max(15_000, e.DATA_REFRESH_MS),
    okx: { site: e.OKX_SITE, apiBase: e.OKX_API_BASE.replace(/\/+$/, ""), cliTimeoutMs: e.OKX_CLI_TIMEOUT_MS },
    risk: {
      startEquityUsd: e.BEE_START_EQUITY_USD,
      maxLeverage: e.MAX_LEVERAGE,
      maxNotionalUsdPerBee: e.MAX_NOTIONAL_USD_PER_BEE,
      dailyLossStopPct: e.DAILY_LOSS_STOP_PCT,
      retireAtPct: e.BEE_RETIRE_AT_PCT,
      liveSizeMultiplier: e.LIVE_SIZE_MULTIPLIER,
      liveRampHours: e.LIVE_RAMP_HOURS,
      takerFeeRate: e.TAKER_FEE_RATE,
      portfolioMaxDrawdownPct: e.PORTFOLIO_MAX_DRAWDOWN_PCT,
      portfolioDailyLossPct: e.PORTFOLIO_DAILY_LOSS_PCT,
      netExposureMaxX: e.NET_EXPOSURE_MAX_X,
      sameCoinMaxWasps: Math.floor(e.SAME_COIN_MAX_WASPS),
      staleFlattenMs: e.STALE_FLATTEN_MINUTES * 60_000,
      regimeFilter: e.REGIME_FILTER,
    },
    news: {
      rss: e.NEWS_RSS,
      rssFeeds: e.NEWS_RSS_FEEDS ? e.NEWS_RSS_FEEDS.split(",").map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x)) : DEFAULT_RSS_FEEDS,
      cryptopanic: e.NEWS_CRYPTOPANIC && !!e.CRYPTOPANIC_TOKEN,
      ...(e.CRYPTOPANIC_TOKEN ? { cryptopanicToken: e.CRYPTOPANIC_TOKEN } : {}),
      ...(e.CRYPTOPANIC_API_URL ? { cryptopanicUrl: e.CRYPTOPANIC_API_URL } : {}),
      webSearch: e.NEWS_WEB_SEARCH && !!knowledgeLlm,
      webSearchEveryMs: Math.max(15, e.NEWS_WEB_SEARCH_EVERY_MIN) * 60_000,
      okx: e.NEWS_OKX,
    },
    knowledge: {
      digest: e.KNOWLEDGE_DIGEST,
      calendar: e.KNOWLEDGE_CALENDAR,
      memory: e.KNOWLEDGE_MEMORY,
      notes: e.KNOWLEDGE_NOTES,
      llm: knowledgeLlm,
      dailyUsdCap: Math.max(0, e.KNOWLEDGE_DAILY_USD_CAP),
      digestEveryMs: Math.max(5, e.DIGEST_EVERY_MIN) * 60_000,
      memoryMinSamples: Math.max(1, Math.floor(e.MEMORY_MIN_SAMPLES)),
      eventsPath: e.EVENTS_PATH,
      ...(e.EVENTS_ICS_URL ? { eventsIcsUrl: e.EVENTS_ICS_URL } : {}),
      notesDir: e.NOTES_DIR,
      notesMaxChars: Math.max(500, e.NOTES_MAX_CHARS),
    },
    universe: { min24hVolUsd: e.MIN_24H_VOL_USD, allowNonCrypto: e.ALLOW_NON_CRYPTO },
    bees: { bizzy: knobs("bizzy"), breezy: knobs("breezy"), boozy: knobs("boozy") },
    breezy: { minOpenProb: e.BREEZY_MIN_OPEN_PROB, minSizeUsd: e.BREEZY_MIN_SIZE_USD },
    bizzy: { sizeFraction: e.BIZZY_SIZE_FRACTION, universeSize: e.BIZZY_UNIVERSE_SIZE, timeStopMinutes: e.BIZZY_TIME_STOP_MINUTES },
    boozy: { candidates: e.BOOZY_CANDIDATES },
    creds,
    server: { port: e.ENGINE_PORT, bind: e.ENGINE_BIND },
    dbPath: e.DB_PATH.replaceAll("{mode}", mode),
    logLevel: e.LOG_LEVEL,
    alertWebhookUrl: e.ALERT_WEBHOOK_URL,
    keeper: { hookUrl: e.BEEKEEPER_WEBHOOK_URL, publicUrl, everyHours, rampStart: e.BEEKEEPER_RAMP_START },
    lab: { secret: e.LAB_SECRET },
  };
}
