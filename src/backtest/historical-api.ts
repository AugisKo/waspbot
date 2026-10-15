// The engine's PublicApi, served from stored history at a simulated clock. The live MarketFeed runs unchanged on top of
// it, so a backtest computes every indicator, gate and regime exactly as paper trading would.
import { kindOf } from "../market/kinds.js";
import type { Candle, FundingNow, Instrument, Ticker } from "../market/types.js";
import type { PublicApi } from "../okx/public.js";
import { BAR_MS, barsAt, lastAtOrBefore, type CoinHistory } from "./data.js";

export interface HistoricalOpts {
  /** Bid/ask spread around the 15m close, in basis points. */
  spreadBps: number;
  /** Funding rate per 8h settlement when the history has none (0.0001 = 0.01%). */
  defaultFundingRate: number;
}

export const btInstId = (coin: string) => `${coin}-USD_UM_XPERP-BT`;

export class HistoricalApi implements PublicApi {
  private byInst = new Map<string, CoinHistory>();
  private insts: Instrument[];

  constructor(
    histories: CoinHistory[],
    private clock: () => number,
    private o: HistoricalOpts,
  ) {
    this.insts = histories.map((h) => {
      const id = btInstId(h.coin);
      this.byInst.set(id, h);
      const first = h.candles[0]?.[4] ?? 1;
      // Fine-grained contracts: about $1 each at the first price, so rounding never decides a trade.
      return { instId: id, coin: h.coin, kind: kindOf(h.coin), ctVal: 1 / first, lotSz: 1, minSz: 1, tickSz: first / 1e6, state: "live" };
    });
  }

  /** The first and last 15m bar times across all coins. */
  span(): { from: number; to: number } {
    const all = [...this.byInst.values()];
    return { from: Math.max(...all.map((h) => h.candles[0]?.[0] ?? Infinity)), to: Math.min(...all.map((h) => h.candles[h.candles.length - 1]?.[0] ?? 0)) + BAR_MS["15m"] };
  }

  async instruments(): Promise<Instrument[]> {
    return this.insts;
  }

  async tickers(): Promise<Map<string, Ticker>> {
    const now = this.clock();
    const out = new Map<string, Ticker>();
    for (const [id, h] of this.byInst) {
      const i = lastAtOrBefore(h.candles, now - BAR_MS["15m"], (r) => r[0]);
      if (i < 0) continue;
      const c = h.candles[i]![4];
      const half = (c * this.o.spreadBps) / 20_000;
      const day = h.candles.slice(Math.max(0, i - 95), i + 1);
      out.set(id, {
        instId: id,
        last: c,
        bid: c - half,
        ask: c + half,
        mid: c,
        spreadBp: this.o.spreadBps,
        vol24hUsd: day.reduce((a, r) => a + r[5], 0),
        open24h: day[0]![1],
        ts: now,
      });
    }
    return out;
  }

  async candles(instId: string, bar: "15m" | "1H" | "4H", limit: number): Promise<Candle[]> {
    const h = this.byInst.get(instId);
    return h ? barsAt(h.candles, BAR_MS[bar], this.clock(), limit) : [];
  }

  async openInterest(): Promise<Map<string, number>> {
    return new Map();
  }

  async funding(instId: string): Promise<FundingNow> {
    const now = this.clock();
    const h = this.byInst.get(instId);
    const i = h ? lastAtOrBefore(h.funding, now, (r) => r[0]) : -1;
    const slot = 8 * 3_600_000;
    return { rate: i >= 0 ? h!.funding[i]![1] : this.o.defaultFundingRate, nextFundingTime: (Math.floor(now / slot) + 1) * slot };
  }

  async fundingHistory(instId: string, limit: number): Promise<number[]> {
    const h = this.byInst.get(instId);
    if (!h || !h.funding.length) return [];
    const i = lastAtOrBefore(h.funding, this.clock(), (r) => r[0]);
    return h.funding.slice(Math.max(0, i - limit + 1), i + 1).map((r) => r[1]);
  }

  /** Close price at `now` (buy-and-hold baselines). */
  priceAt(coin: string, now: number): number | null {
    const h = this.byInst.get(btInstId(coin));
    const i = h ? lastAtOrBefore(h.candles, now - BAR_MS["15m"], (r) => r[0]) : -1;
    return i >= 0 ? h!.candles[i]![4] : null;
  }
}
