// Yahoo Finance as a backtest data source: spot crypto prices (BTC-USD, ...) from the chart feed Yahoo's own pages use.
// Not an official API, so it can change or rate-limit without notice; for personal research only (Yahoo's terms).
// Limits: 15-minute candles only for about the last 60 days; no funding history (the backtester assumes 0.01% / 8 h).
import { BAR_MS, type CoinHistory, type Row } from "./data.js";

export const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
/** Yahoo serves 15m bars for at most 60 days back; ask for a little less so the edge never fails. */
export const YAHOO_MAX_15M_DAYS = 59;

/**
 * The Yahoo symbol for a coin. Most are "<COIN>-USD"; coins whose ticker clashes with another asset carry a number
 * ("SUI20947-USD", "HYPE32196-USD"). Pass "SUI:SUI20947-USD" on the command line to say which one.
 */
export function yahooSymbol(spec: string): { coin: string; symbol: string } {
  const [coin, sym] = spec.split(":");
  const c = coin!.trim().toUpperCase();
  return { coin: c, symbol: (sym?.trim() || `${c}-USD`).toUpperCase() };
}

interface ChartResponse {
  chart?: {
    result?: Array<{
      meta?: { symbol?: string; instrumentType?: string; dataGranularity?: string };
      timestamp?: number[];
      indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }> };
    }>;
    error?: { code?: string; description?: string } | null;
  };
}

/**
 * Yahoo's chart JSON to the backtester's 15m rows. Keeps only complete bars: aligned to 15 minutes, every price
 * present, and closed by `now` (Yahoo adds a live, unaligned last bar). Volume is USD for crypto pairs.
 */
export function parseYahooChart(data: unknown, now: number = Date.now()): { rows: Row[]; symbol: string; type: string | null } {
  const d = data as ChartResponse;
  if (d.chart?.error) throw new Error(`Yahoo: ${d.chart.error.code ?? "error"} ${d.chart.error.description ?? ""}`.trim());
  const r = d.chart?.result?.[0];
  if (!r) throw new Error("Yahoo sent no chart data");
  const ts = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0] ?? {};
  const step = BAR_MS["15m"];
  const rows: Row[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]! * 1000;
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (t % step !== 0 || t + step > now) continue;
    if ([o, h, l, c].some((x) => x === null || x === undefined || !Number.isFinite(x) || x <= 0)) continue;
    rows.push([t, o!, Math.max(h!, o!, c!), Math.min(l!, o!, c!), c!, Math.max(0, q.volume?.[i] ?? 0)]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const seen = new Set<number>();
  return { rows: rows.filter((x) => !seen.has(x[0]) && (seen.add(x[0]), true)), symbol: r.meta?.symbol ?? "", type: r.meta?.instrumentType ?? null };
}

export function yahooUrl(symbol: string, days: number, now: number = Date.now()): string {
  const p2 = Math.floor(now / 1000);
  const p1 = p2 - Math.min(days, YAHOO_MAX_15M_DAYS) * 86_400;
  return `${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=15m&period1=${p1}&period2=${p2}&includePrePost=false`;
}

/** One coin's 15m history from Yahoo. `fetchJson` does the network call (and its error messages). */
export async function fetchYahoo(spec: string, days: number, fetchJson: (url: string) => Promise<unknown>, now: number = Date.now()): Promise<CoinHistory> {
  const { coin, symbol } = yahooSymbol(spec);
  const { rows, type } = parseYahooChart(await fetchJson(yahooUrl(symbol, days, now)), now);
  if (type && type !== "CRYPTOCURRENCY") throw new Error(`${symbol} is a ${type.toLowerCase()} on Yahoo, not a coin: pass ${coin}:<the right Yahoo symbol>, e.g. SUI:SUI20947-USD`);
  if (!rows.length) throw new Error(`Yahoo has no 15-minute bars for ${symbol}`);
  return { coin, source: `yahoo ${symbol} (spot, 15m; funding assumed)`, candles: rows, funding: [] };
}
