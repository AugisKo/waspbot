// Trade memory: every closed trade is stored with the market picture at entry (regime, RSI, 24 h return, volatility,
// funding, news sentiment) and how it ended (in R: P&L over the risk taken). Before a new open, the k most similar past
// trades of the same style and side are looked up. The summary goes to the model as context, and when enough similar
// trades lost on average, the new one is opened smaller. Memory never vetoes and never opens.
//
// Small samples lie: nothing acts on fewer than MEMORY_MIN_SAMPLES similar trades.
import type { Db } from "../db.js";
import type { CoinStats } from "../market/types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trade_memory (
  id INTEGER PRIMARY KEY, wasp TEXT NOT NULL, style TEXT NOT NULL, coin TEXT NOT NULL, side TEXT NOT NULL,
  opened_at INTEGER NOT NULL, closed_at INTEGER NOT NULL, r_mult REAL NOT NULL, pnl_usd REAL NOT NULL,
  reason TEXT, features_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trade_memory_style ON trade_memory(style, side);
`;

/** The entry picture. Every field may be null (not enough data at the time). */
export interface EntryFeatures {
  regime: "trend" | "range" | "chop" | null;
  regimeDir: number | null;
  adx: number | null;
  er: number | null;
  rsi14: number | null;
  ret24hPct: number | null;
  atr14Pct: number | null;
  fundingZ: number | null;
  volZ: number | null;
  newsSentiment: number | null;
}

export interface ClosedTrade {
  wasp: string;
  style: string;
  coin: string;
  side: "long" | "short";
  openedAt: number;
  closedAt: number;
  /** Net P&L of the trade (realised minus fees). */
  pnlUsd: number;
  /** 1R: what the trade risked at entry. */
  riskUsd: number;
  reason: string | null;
  features: EntryFeatures;
}

export interface MemorySummary {
  n: number;
  winRate: number;
  avgR: number;
  /** Mean distance of the neighbours (lower = more alike). */
  meanDist: number;
}

export function featuresOf(s: CoinStats | undefined, newsSentiment: number | null): EntryFeatures {
  return {
    regime: s?.regime?.kind ?? null,
    regimeDir: s?.regime?.dir ?? null,
    adx: s?.regime?.adx ?? null,
    er: s?.regime?.er ?? null,
    rsi14: s?.rsi14 ?? null,
    ret24hPct: s?.ret24hPct ?? null,
    atr14Pct: s?.atr14Pct ?? null,
    fundingZ: s?.fundingZ ?? null,
    volZ: s?.volZ ?? null,
    newsSentiment,
  };
}

/** Typical spread of each feature: a difference of one scale unit counts as distance 1. */
const SCALES: Array<[keyof EntryFeatures, number]> = [
  ["adx", 10],
  ["er", 0.2],
  ["rsi14", 15],
  ["ret24hPct", 4],
  ["atr14Pct", 0.5],
  ["fundingZ", 1],
  ["volZ", 1.5],
  ["newsSentiment", 0.5],
];

export function distance(a: EntryFeatures, b: EntryFeatures): number {
  let sum = 0;
  let n = 0;
  for (const [k, scale] of SCALES) {
    const x = a[k] as number | null;
    const y = b[k] as number | null;
    if (x === null || y === null) continue;
    sum += ((x - y) / scale) ** 2;
    n++;
  }
  const regimePenalty = a.regime && b.regime && a.regime !== b.regime ? 2 : 0;
  return (n ? Math.sqrt(sum / n) : 1) + regimePenalty;
}

export class TradeMemory {
  constructor(private db: Db) {
    db.raw.exec(SCHEMA);
  }

  record(t: ClosedTrade): void {
    const r = t.riskUsd > 0 ? t.pnlUsd / t.riskUsd : 0;
    this.db.raw
      .prepare(`INSERT INTO trade_memory (wasp, style, coin, side, opened_at, closed_at, r_mult, pnl_usd, reason, features_json) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(t.wasp, t.style, t.coin, t.side, t.openedAt, t.closedAt, Math.max(-10, Math.min(20, r)), t.pnlUsd, t.reason, JSON.stringify(t.features));
  }

  count(): number {
    return Number((this.db.raw.prepare(`SELECT COUNT(*) AS n FROM trade_memory`).get() as { n: number }).n);
  }

  /** The k nearest past trades of this style and side (the most recent 2000 are searched). */
  similar(style: string, side: "long" | "short", f: EntryFeatures, k = 20): MemorySummary | null {
    const rows = this.db.raw
      .prepare(`SELECT r_mult AS r, features_json AS f FROM trade_memory WHERE style = ? AND side = ? ORDER BY closed_at DESC LIMIT 2000`)
      .all(style, side) as Array<{ r: number; f: string }>;
    if (!rows.length) return null;
    const scored = rows
      .map((row) => {
        try {
          return { r: row.r, d: distance(f, JSON.parse(row.f) as EntryFeatures) };
        } catch {
          return null;
        }
      })
      .filter((x): x is { r: number; d: number } => x !== null)
      .sort((a, b) => a.d - b.d)
      .slice(0, k);
    if (!scored.length) return null;
    const n = scored.length;
    return {
      n,
      winRate: scored.filter((s) => s.r > 0).length / n,
      avgR: scored.reduce((a, s) => a + s.r, 0) / n,
      meanDist: scored.reduce((a, s) => a + s.d, 0) / n,
    };
  }

  /** Overall record per style, for the dashboard. */
  byStyle(): Array<{ style: string; n: number; winRate: number; avgR: number }> {
    const rows = this.db.raw.prepare(`SELECT style, COUNT(*) AS n, AVG(CASE WHEN r_mult > 0 THEN 1.0 ELSE 0.0 END) AS w, AVG(r_mult) AS r FROM trade_memory GROUP BY style`).all() as Array<{ style: string; n: number; w: number; r: number }>;
    return rows.map((r) => ({ style: r.style, n: Number(r.n), winRate: Number(r.w), avgR: Number(r.r) }));
  }
}
