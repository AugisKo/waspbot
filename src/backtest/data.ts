// Historical market data for backtests: 15-minute candles and funding rates per coin, stored as JSON files under
// data/backtest/ (fetched once with `pnpm backtest:fetch`). Everything else (1h and 4h bars, tickers, 24h volume) is
// derived from the 15m bars at the simulated time, so the engine never sees a bar that has not closed yet.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Candle } from "../market/types.js";

export const BAR_MS = { "15m": 15 * 60_000, "1H": 3_600_000, "4H": 4 * 3_600_000 } as const;

/** [ts, open, high, low, close, volumeUsd], oldest first. */
export type Row = [number, number, number, number, number, number];

export interface CoinHistory {
  coin: string;
  /** Where the bars came from (an X-Perp id, a -USDT-SWAP id, or "synthetic"). */
  source: string;
  candles: Row[];
  /** [ts, rate] per funding settlement, oldest first. Empty = use the default rate. */
  funding: Array<[number, number]>;
}

export const historyPath = (dir: string, coin: string) => join(dir, `${coin.toUpperCase()}.json`);

export function saveHistory(dir: string, h: CoinHistory): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(historyPath(dir, h.coin), JSON.stringify(h));
}

export function loadHistory(dir: string, coin: string): CoinHistory {
  const p = historyPath(dir, coin);
  if (!existsSync(p)) throw new Error(`no data for ${coin} in ${dir}: run pnpm backtest:fetch --coins ${coin} first (or use --synthetic)`);
  const h = JSON.parse(readFileSync(p, "utf8")) as CoinHistory;
  h.candles.sort((a, b) => a[0] - b[0]);
  h.funding = (h.funding ?? []).sort((a, b) => a[0] - b[0]);
  return h;
}

/** Index of the last element with key <= x (binary search), or -1. */
export function lastAtOrBefore<T>(arr: readonly T[], x: number, key: (t: T) => number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]!) <= x) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Bars of one size from the 15m rows, as they look at time `now`: every bar that has fully closed (confirmed), plus the
 * current bar built from the 15m bars closed so far (not confirmed). Nothing after `now` is ever used.
 */
export function barsAt(rows: Row[], barMs: number, now: number, limit: number): Candle[] {
  const step = BAR_MS["15m"];
  // Last 15m bar that has CLOSED by now.
  const last = lastAtOrBefore(rows, now - step, (r) => r[0]);
  if (last < 0) return [];
  if (barMs === step) {
    const from = Math.max(0, last - limit + 1);
    return rows.slice(from, last + 1).map((r) => ({ ts: r[0], o: r[1], h: r[2], l: r[3], c: r[4], volUsd: r[5], confirmed: true }));
  }
  const per = Math.round(barMs / step);
  const out: Candle[] = [];
  // Walk back from the last closed 15m bar, grouping by bar start.
  let i = last;
  while (i >= 0 && out.length < limit) {
    const start = Math.floor(rows[i]![0] / barMs) * barMs;
    let j = i;
    while (j - 1 >= 0 && rows[j - 1]![0] >= start) j--;
    const g = rows.slice(j, i + 1);
    out.push({
      ts: start,
      o: g[0]![1],
      h: Math.max(...g.map((r) => r[2])),
      l: Math.min(...g.map((r) => r[3])),
      c: g[g.length - 1]![4],
      volUsd: g.reduce((a, r) => a + r[5], 0),
      confirmed: g.length >= per && start + barMs <= now,
    });
    i = j - 1;
  }
  return out.reverse();
}
