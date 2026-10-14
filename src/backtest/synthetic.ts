// Synthetic 15m history for tests and for trying the backtester without downloading anything. A seeded random walk
// that switches between trending, ranging and choppy stretches. It says nothing about real markets: results on it
// only show that the pipeline works.
import { BAR_MS, type CoinHistory, type Row } from "./data.js";

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  const u = Math.max(1e-12, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

export function syntheticHistory(coin: string, o: { from: number; days: number; startPx: number; seed: number; volUsdPerBar?: number }): CoinHistory {
  const r = rng(o.seed);
  const step = BAR_MS["15m"];
  const n = Math.floor((o.days * 86_400_000) / step);
  const rows: Row[] = [];
  let px = o.startPx;
  let drift = 0;
  let vol = 0.004;
  let left = 0;
  for (let i = 0; i < n; i++) {
    if (left-- <= 0) {
      // A new stretch of 1-6 days: trend up, trend down, quiet range or chop.
      const k = r();
      left = Math.floor((1 + r() * 5) * 96);
      // Per 15m bar: a trend moves ~1%/day with ~2%/day noise; chop has ~4%/day noise and no direction.
      if (k < 0.25) [drift, vol] = [0.0001, 0.002];
      else if (k < 0.5) [drift, vol] = [-0.0001, 0.002];
      else if (k < 0.8) [drift, vol] = [0, 0.0012];
      else [drift, vol] = [0, 0.004];
    }
    const ret = drift + vol * gauss(r);
    const open = px;
    const close = Math.max(1e-9, px * Math.exp(ret));
    const wick = Math.abs(gauss(r)) * vol * 0.5;
    rows.push([o.from + i * step, open, Math.max(open, close) * (1 + wick), Math.min(open, close) * (1 - wick), close, (o.volUsdPerBar ?? 2e6) * (0.5 + r())]);
    px = close;
  }
  const funding: Array<[number, number]> = [];
  for (let t = Math.ceil(o.from / (8 * 3_600_000)) * 8 * 3_600_000; t < o.from + o.days * 86_400_000; t += 8 * 3_600_000) funding.push([t, 0.0001 + 0.0001 * gauss(r)]);
  return { coin, source: "synthetic", candles: rows, funding };
}
