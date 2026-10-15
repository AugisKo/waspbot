// Per-coin news digest: what the last 24 h of headlines add up to, as numbers and a few flags a risk rule can read.
// Two ways to make one, and the cheaper one is always there:
// - keywords (free, instant): sentiment from a small word list, risk flags from fixed patterns ("hack", "delist", ...);
// - a model (KNOWLEDGE_LLM): reads the headlines and returns the same shape, plus short event notes. Runs at most every
//   DIGEST_EVERY_MIN per coin, only when there is news it has not seen, and inside the knowledge layer's daily budget.
// The digest may make a wasp more careful (veto a long into an exploit, shrink a trade against strong news). It never
// opens anything.
import type { Db } from "../db.js";
import type { KnowledgeLlm } from "../llm/client.js";
import type { NewsHub } from "../news/hub.js";
import type { NewsItem } from "../news/types.js";

export const RISK_FLAGS = ["hack", "exploit", "delisting", "insolvency", "depeg", "regulatory_action", "lawsuit", "outage", "token_unlock", "network_halt"] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];
/** Flags serious enough to keep longs out of the coin entirely while they are fresh. */
export const SEVERE_FLAGS: readonly RiskFlag[] = ["hack", "exploit", "delisting", "insolvency", "depeg", "network_halt"];

export interface Digest {
  coin: string;
  at: number;
  /** -1 (very bearish) .. +1 (very bullish). */
  sentiment: number;
  /** 0..1: how much the digest believes its own sentiment (few or mixed items = low). */
  confidence: number;
  flags: RiskFlag[];
  /** Up to 3 short notes ("ETF inflows +$400m", "Mainnet upgrade Oct 20"). */
  events: string[];
  items: number;
  by: "keywords" | "llm";
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS news_digests (coin TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (coin, at));`;

const FLAG_PATTERNS: Array<[RiskFlag, RegExp]> = [
  ["hack", /\b(hack(ed|er|s)?|stolen|drain(ed)?|breach(ed)?)\b/i],
  ["exploit", /\b(exploit(ed|s)?|attack(ed)?|vulnerabilit(y|ies)|rug ?pull)\b/i],
  ["delisting", /\b(delist(s|ed|ing)?|suspend(s|ed)? (trading|deposits|withdrawals))\b/i],
  ["insolvency", /\b(insolven(t|cy)|bankrupt(cy)?|halts? withdrawals|chapter 11)\b/i],
  ["depeg", /\b(de-?peg(ged|s)?|loses? (its )?peg)\b/i],
  ["regulatory_action", /\b(sec (sues|charges)|enforcement action|ban(s|ned)? (crypto|trading)|cease and desist|wells notice)\b/i],
  ["lawsuit", /\b(lawsuit|sued|class action|indict(ed|ment))\b/i],
  ["outage", /\b(outage|downtime|degraded performance)\b/i],
  ["token_unlock", /\b(token unlock|unlock of|vesting unlock)\b/i],
  ["network_halt", /\b(network (halt|halted|stalls?|down)|chain halt(ed)?|block production (halted|stopped))\b/i],
];

const POS = /\b(surge[sd]?|soar(s|ed)?|rall(y|ies|ied)|record high|all-time high|ath|approv(al|ed|es)|inflows?|adopt(s|ed|ion)|partnership|upgrade[sd]?|bullish|beats?|gain(s|ed)?|jumps?|rebound(s|ed)?|breakout)\b/gi;
const NEG = /\b(plunge[sd]?|crash(es|ed)?|tumble[sd]?|slump(s|ed)?|sell-?off|outflows?|bearish|reject(s|ed|ion)|liquidat(ed|ions?)|fears?|drops?|falls?|slides?|dumps?|warns?|probe|investigat(ion|es|ed))\b/gi;

/** The keyword digest: free, deterministic, always available. */
export function keywordDigest(coin: string, items: NewsItem[], now: number): Digest {
  const flags = new Set<RiskFlag>();
  let score = 0;
  let weight = 0;
  for (const i of items) {
    const text = `${i.title} ${i.summary ?? ""}`;
    // Only coin-specific items raise flags for the coin; a market-wide hack elsewhere is not this coin's exploit.
    if (i.coins.includes(coin)) for (const [f, re] of FLAG_PATTERNS) if (re.test(text)) flags.add(f);
    const ageH = Math.max(0, (now - i.publishedAt) / 3_600_000);
    const w = Math.exp(-ageH / 12) * (i.coins.includes(coin) ? 1 : 0.4);
    const pos = (text.match(POS) ?? []).length;
    const neg = (text.match(NEG) ?? []).length;
    const s = i.sentiment ?? (pos + neg > 0 ? (pos - neg) / (pos + neg) : 0);
    score += w * s;
    weight += w;
  }
  const sentiment = weight > 0 ? Math.max(-1, Math.min(1, score / weight)) : 0;
  const n = items.filter((i) => i.coins.includes(coin)).length;
  return { coin, at: now, sentiment: Number(sentiment.toFixed(2)), confidence: Number(Math.min(0.6, n / 15).toFixed(2)), flags: [...flags], events: [], items: items.length, by: "keywords" };
}

export function validateDigest(coin: string, now: number, items: number) {
  return (v: unknown): Digest | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const s = Number(o.sentiment);
    const c = Number(o.confidence);
    if (!Number.isFinite(s) || !Number.isFinite(c)) return null;
    const flags = Array.isArray(o.flags) ? o.flags.filter((f): f is RiskFlag => RISK_FLAGS.includes(f as RiskFlag)) : [];
    const events = Array.isArray(o.events) ? o.events.filter((e): e is string => typeof e === "string").map((e) => e.slice(0, 80)).slice(0, 3) : [];
    return { coin, at: now, sentiment: Math.max(-1, Math.min(1, s)), confidence: Math.max(0, Math.min(1, c)), flags: [...new Set(flags)], events, items, by: "llm" };
  };
}

export function digestPrompt(coin: string, items: NewsItem[], now: number): string {
  const lines = items
    .slice(0, 25)
    .map((i) => `- [${Math.round((now - i.publishedAt) / 3_600_000)}h ago, ${i.publisher}${i.coins.length ? `, ${i.coins.join("/")}` : ", market-wide"}] ${i.title}${i.summary ? ` — ${i.summary.slice(0, 160)}` : ""}`)
    .join("\n");
  return [
    `You are a careful crypto news analyst. Below are recent headlines. Judge what they mean for ${coin} perpetual futures over the next 24 hours.`,
    "Be conservative: headlines are noisy, rumours are not facts, and most news is already priced in. Low confidence is the right answer when items are few, old or mixed.",
    `Risk flags (only when an item clearly says so about ${coin} itself): ${RISK_FLAGS.join(", ")}.`,
    `Headlines:\n${lines || "(none)"}`,
    'Return JSON: {"sentiment":-1..1,"confidence":0..1,"flags":["..."],"events":["short note", "..."]} with at most 3 events of at most 80 characters.',
  ].join("\n\n");
}

export class DigestStore {
  private latest = new Map<string, Digest>();
  private lastLlmAt = new Map<string, number>();
  private seenVersion = new Map<string, number>();

  constructor(
    private o: {
      db: Db;
      hub: NewsHub;
      llm: () => KnowledgeLlm | null;
      /** Use the model at all (dashboard control "digest"); off = keyword digests only. */
      useLlm: () => boolean;
      everyMs: number;
      now?: () => number;
    },
  ) {
    o.db.raw.exec(SCHEMA);
    // Last digest per coin survives a restart.
    const rows = o.db.raw.prepare(`SELECT coin, json FROM news_digests d WHERE at = (SELECT MAX(at) FROM news_digests WHERE coin = d.coin)`).all() as Array<{ coin: string; json: string }>;
    for (const r of rows) {
      try {
        this.latest.set(r.coin, JSON.parse(r.json) as Digest);
      } catch {
        /* skip a bad row */
      }
    }
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  get(coin: string): Digest | null {
    return this.latest.get(coin) ?? null;
  }

  /** Refresh the digests for these coins (keywords always; the model when due and there is something new). */
  async refresh(coins: string[]): Promise<void> {
    const now = this.now();
    for (const coin of coins) {
      const items = this.o.hub.recent(coin, 24, 40);
      let d = keywordDigest(coin, items, now);
      const llm = this.o.useLlm() ? this.o.llm() : null;
      const fresh = this.o.hub.version !== this.seenVersion.get(coin);
      const coinItems = items.filter((i) => i.coins.includes(coin)).length;
      if (llm && fresh && coinItems > 0 && now - (this.lastLlmAt.get(coin) ?? 0) >= this.o.everyMs) {
        this.lastLlmAt.set(coin, now);
        const r = await llm.json({ prompt: digestPrompt(coin, items, now), maxOutputTokens: 400, temperature: 0, jsonSchema: DIGEST_SCHEMA }, validateDigest(coin, now, items.length));
        if (r.ok) {
          // The model may add flags and notes, but the keyword flags stay: a pattern match on "exploit" is not argued away.
          d = { ...r.value, flags: [...new Set([...r.value.flags, ...d.flags])] };
          this.seenVersion.set(coin, this.o.hub.version);
        }
      } else if (!llm) this.seenVersion.set(coin, this.o.hub.version);
      // Between model runs, keep the model's read but refresh flags from keywords.
      const prev = this.latest.get(coin);
      if (d.by === "keywords" && prev?.by === "llm" && now - prev.at < 2 * this.o.everyMs) d = { ...prev, flags: [...new Set([...prev.flags, ...d.flags])] };
      this.latest.set(coin, d);
      this.o.db.raw.prepare(`INSERT OR REPLACE INTO news_digests (coin, at, json) VALUES (?,?,?)`).run(coin, d.at, JSON.stringify(d));
    }
    this.o.db.raw.prepare(`DELETE FROM news_digests WHERE at < ?`).run(now - 7 * 86_400_000);
  }
}

export const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    sentiment: { type: "number" },
    confidence: { type: "number" },
    flags: { type: "array", items: { type: "string" } },
    events: { type: "array", items: { type: "string" } },
  },
  required: ["sentiment", "confidence", "flags", "events"],
  additionalProperties: false,
};
