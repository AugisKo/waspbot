// Market regime per coin, from 1h candles: is the coin trending (and which way), ranging quietly, or chopping around
// with high volatility and no direction? Used by the risk layer to decide which trading style may open at all
// (REGIME_FILTER). Pure: candles in, numbers out.
//
// - ADX(14), Wilder smoothing: trend strength regardless of direction.
// - Efficiency ratio over 24 bars (Kaufman): net move / sum of absolute moves. 1 = a straight line, 0 = pure noise.
// - Volatility percentile: today's ATR% against the last week of ATR% readings.
import type { Candle } from "./types.js";

export type RegimeKind = "trend" | "range" | "chop";

export interface Regime {
  kind: RegimeKind;
  /** Direction of the trend: +1 up, -1 down, 0 none (range/chop). */
  dir: -1 | 0 | 1;
  adx: number | null;
  er: number | null;
  /** Current ATR% rank within the last `volLookback` readings, 0..1. */
  volPct: number | null;
}

export interface RegimeOpts {
  adxTrend: number;
  erTrend: number;
  chopVolPct: number;
}

export const REGIME_DEFAULTS: RegimeOpts = { adxTrend: 22, erTrend: 0.3, chopVolPct: 0.8 };

/** Wilder's ADX. Needs 2 x period + 1 bars; null before that. */
export function adx(c: Candle[], period = 14): number | null {
  if (c.length < 2 * period + 1) return null;
  const tr: number[] = [];
  const pdm: number[] = [];
  const ndm: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i]!.h - c[i - 1]!.h;
    const down = c[i - 1]!.l - c[i]!.l;
    pdm.push(up > down && up > 0 ? up : 0);
    ndm.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(c[i]!.h - c[i]!.l, Math.abs(c[i]!.h - c[i - 1]!.c), Math.abs(c[i]!.l - c[i - 1]!.c)));
  }
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let p = pdm.slice(0, period).reduce((a, b) => a + b, 0);
  let n = ndm.slice(0, period).reduce((a, b) => a + b, 0);
  const dx: number[] = [];
  for (let i = period; i <= tr.length; i++) {
    if (i > period) {
      atr = atr - atr / period + tr[i - 1]!;
      p = p - p / period + pdm[i - 1]!;
      n = n - n / period + ndm[i - 1]!;
    }
    if (atr <= 0) {
      dx.push(0);
      continue;
    }
    const pdi = (100 * p) / atr;
    const ndi = (100 * n) / atr;
    dx.push(pdi + ndi > 0 ? (100 * Math.abs(pdi - ndi)) / (pdi + ndi) : 0);
  }
  if (dx.length < period) return null;
  let a = dx.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < dx.length; i++) a = (a * (period - 1) + dx[i]!) / period;
  return a;
}

/** Kaufman efficiency ratio over the last `n` closes. */
export function efficiencyRatio(closes: number[], n = 24): number | null {
  if (closes.length < n + 1) return null;
  const s = closes.slice(-(n + 1));
  const net = Math.abs(s[s.length - 1]! - s[0]!);
  let path = 0;
  for (let i = 1; i < s.length; i++) path += Math.abs(s[i]! - s[i - 1]!);
  return path > 0 ? net / path : 0;
}

/** Rank of the latest ATR% among the last `lookback` rolling ATR% readings, 0..1. */
export function volPercentile(c: Candle[], period = 14, lookback = 168): number | null {
  if (c.length < period + 2) return null;
  const tr: number[] = [];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i]!.h - c[i]!.l, Math.abs(c[i]!.h - c[i - 1]!.c), Math.abs(c[i]!.l - c[i - 1]!.c)) / c[i]!.c);
  const atrs: number[] = [];
  for (let i = period; i <= tr.length; i++) atrs.push(tr.slice(i - period, i).reduce((a, b) => a + b, 0) / period);
  const hist = atrs.slice(-lookback);
  if (hist.length < 10) return null;
  const cur = hist[hist.length - 1]!;
  // Mid-rank: ties count half, so a perfectly steady market sits at 0.5, not at the top.
  return (hist.filter((x) => x < cur).length + 0.5 * hist.filter((x) => x === cur).length) / hist.length;
}

export function classifyRegime(c1h: Candle[], o: RegimeOpts = REGIME_DEFAULTS): Regime {
  const closes = c1h.map((c) => c.c);
  const a = adx(c1h);
  const er = efficiencyRatio(closes);
  const vp = volPercentile(c1h);
  if (a !== null && er !== null && a >= o.adxTrend && er >= o.erTrend) {
    const back = closes[closes.length - 25];
    const dir = back === undefined ? 0 : closes[closes.length - 1]! > back ? 1 : closes[closes.length - 1]! < back ? -1 : 0;
    if (dir !== 0) return { kind: "trend", dir, adx: a, er, volPct: vp };
  }
  if (vp !== null && vp >= o.chopVolPct) return { kind: "chop", dir: 0, adx: a, er, volPct: vp };
  return { kind: "range", dir: 0, adx: a, er, volPct: vp };
}

/**
 * Which styles may open in which regime (null = allowed, else the veto reason).
 * - Trend and Momentum follow moves: they open only with a trend in the same direction.
 * - Breakout trades both breakouts and fades: it stays out only of directionless high-volatility chop.
 * Unknown regime (not enough data) never vetoes: the other gates still apply.
 */
export function regimeVeto(style: "bizzy" | "breezy" | "boozy", side: "long" | "short", r: Regime | undefined | null): string | null {
  if (!r || r.adx === null) return null;
  const want = side === "long" ? 1 : -1;
  if (style === "bizzy") return r.kind === "chop" ? `regime chop (vol p${Math.round((r.volPct ?? 0) * 100)})` : null;
  if (r.kind !== "trend") return `regime ${r.kind} (adx ${r.adx.toFixed(0)})`;
  if (r.dir !== want) return `regime trend ${r.dir > 0 ? "up" : "down"} vs ${side}`;
  return null;
}
