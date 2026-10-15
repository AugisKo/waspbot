// Honest numbers for a backtest: returns after fees, slippage and funding, risk-adjusted, with drawdowns, against a
// buy-and-hold baseline. Pure functions over an equity curve and a trade list.

export interface Point {
  ts: number;
  equity: number;
}

export interface TradeRec {
  closedAt: number;
  openedAt: number;
  pnlUsd: number;
  r: number;
}

export interface Metrics {
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  /** Annualised (365-day) compound return. */
  cagrPct: number;
  /** Daily returns, annualised with sqrt(365). Crypto trades every day. */
  sharpe: number | null;
  sortino: number | null;
  maxDrawdownPct: number;
  /** Longest time below a previous peak, in days. */
  maxDrawdownDays: number;
  calmar: number | null;
  days: number;
  trades: number;
  winRatePct: number | null;
  avgR: number | null;
  profitFactor: number | null;
  avgHoldHours: number | null;
  feesUsd: number;
  fundingUsd: number;
  /** Fees as a share of the start equity, in %. */
  feeDragPct: number;
  /** Share of the time with a position open, in % (null when unknown). */
  exposurePct: number | null;
}

/** End-of-UTC-day equity values (the last point of each day). */
export function dailyCloses(curve: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of curve) {
    const day = Math.floor(p.ts / 86_400_000);
    const last = out[out.length - 1];
    if (last && Math.floor(last.ts / 86_400_000) === day) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

export function drawdown(curve: Point[]): { maxPct: number; maxDays: number } {
  let peak = -Infinity;
  let peakAt = curve[0]?.ts ?? 0;
  let maxPct = 0;
  let maxDays = 0;
  for (const p of curve) {
    if (p.equity >= peak) {
      peak = p.equity;
      peakAt = p.ts;
    } else {
      maxPct = Math.max(maxPct, ((peak - p.equity) / peak) * 100);
      maxDays = Math.max(maxDays, (p.ts - peakAt) / 86_400_000);
    }
  }
  return { maxPct, maxDays };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};

export function computeMetrics(curve: Point[], trades: TradeRec[], extra: { feesUsd: number; fundingUsd: number; exposurePct: number | null }): Metrics {
  const start = curve[0]?.equity ?? 0;
  const end = curve[curve.length - 1]?.equity ?? start;
  const days = curve.length > 1 ? (curve[curve.length - 1]!.ts - curve[0]!.ts) / 86_400_000 : 0;
  const closes = [curve[0]!, ...dailyCloses(curve)].filter((p, i, a) => i === 0 || p.ts !== a[i - 1]!.ts);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i]!.equity / closes[i - 1]!.equity - 1);
  const sd = rets.length > 2 ? std(rets) : 0;
  const downs = rets.filter((x) => x < 0);
  const dsd = downs.length > 2 ? Math.sqrt(downs.reduce((a, b) => a + b * b, 0) / rets.length) : 0;
  const dd = drawdown(curve);
  const total = start > 0 ? (end / start - 1) * 100 : 0;
  const cagr = start > 0 && end > 0 && days >= 1 ? ((end / start) ** (365 / days) - 1) * 100 : total;
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const gw = wins.reduce((a, t) => a + t.pnlUsd, 0);
  const gl = -losses.reduce((a, t) => a + t.pnlUsd, 0);
  return {
    startEquity: start,
    endEquity: end,
    totalReturnPct: total,
    cagrPct: cagr,
    sharpe: sd > 0 ? (mean(rets) / sd) * Math.sqrt(365) : null,
    sortino: dsd > 0 ? (mean(rets) / dsd) * Math.sqrt(365) : null,
    maxDrawdownPct: dd.maxPct,
    maxDrawdownDays: dd.maxDays,
    calmar: dd.maxPct > 0 ? cagr / dd.maxPct : null,
    days,
    trades: trades.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
    avgR: trades.length ? mean(trades.map((t) => t.r)) : null,
    profitFactor: gl > 0 ? gw / gl : wins.length ? Infinity : null,
    avgHoldHours: trades.length ? mean(trades.map((t) => (t.closedAt - t.openedAt) / 3_600_000)) : null,
    feesUsd: extra.feesUsd,
    fundingUsd: extra.fundingUsd,
    feeDragPct: start > 0 ? (extra.feesUsd / start) * 100 : 0,
    exposurePct: extra.exposurePct,
  };
}

/** The part of a curve inside [from, to], for in-sample / out-of-sample splits. */
export function window(curve: Point[], from: number, to: number): Point[] {
  return curve.filter((p) => p.ts >= from && p.ts <= to);
}
