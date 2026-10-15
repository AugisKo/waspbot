// Built from a real Yahoo response (BTC-USD, 15m, 5 days), trimmed: 12 bars from the start, the last aligned bar (still forming when Yahoo answered), and
// the live unaligned bar Yahoo appends. One bar's prices were nulled to stand for the gaps Yahoo sometimes sends.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { barsAt } from "../src/backtest/data.js";
import { fetchYahoo, parseYahooChart, yahooSymbol, yahooUrl, YAHOO_MAX_15M_DAYS } from "../src/backtest/yahoo.js";

const sample = JSON.parse(readFileSync(new URL("./fixtures/yahoo-btc-15m.json", import.meta.url), "utf8"));
const ts = sample.chart.result[0].timestamp as number[];
const NOW = (ts[ts.length - 1]! + 60) * 1000; // just after the live bar's last tick

describe("yahoo", () => {
  it("keeps complete, aligned, closed bars and drops the live one and the gap", () => {
    const { rows, symbol, type } = parseYahooChart(sample, NOW);
    expect(symbol).toBe("BTC-USD");
    expect(type).toBe("CRYPTOCURRENCY");
    // 14 bars - 1 null gap - the bar still forming (aligned, but not closed yet) - the live unaligned tick.
    expect(rows).toHaveLength(11);
    expect(rows[0]).toEqual([ts[0]! * 1000, 82913.296875, 82954.4921875, 82910.9375, 82952.2109375, 0]);
    for (const r of rows) {
      expect(r[0] % (15 * 60_000)).toBe(0);
      expect(r[2]).toBeGreaterThanOrEqual(Math.max(r[1], r[4]));
      expect(r[3]).toBeLessThanOrEqual(Math.min(r[1], r[4]));
    }
    expect(rows.map((r) => r[0])).toEqual([...rows.map((r) => r[0])].sort((a, b) => a - b));
  });

  it("feeds the backtester's bar builder", () => {
    const { rows } = parseYahooChart(sample, NOW);
    expect(barsAt(rows, 15 * 60_000, rows[5]![0] + 15 * 60_000, 100)).toHaveLength(6);
  });

  it("maps coins to Yahoo symbols, with an override for clashing tickers", () => {
    expect(yahooSymbol("btc")).toEqual({ coin: "BTC", symbol: "BTC-USD" });
    expect(yahooSymbol("SUI:SUI20947-USD")).toEqual({ coin: "SUI", symbol: "SUI20947-USD" });
    const u = new URL(yahooUrl("BTC-USD", 120, NOW));
    expect(u.searchParams.get("interval")).toBe("15m");
    expect(Number(u.searchParams.get("period2")) - Number(u.searchParams.get("period1"))).toBe(YAHOO_MAX_15M_DAYS * 86_400);
  });

  it("refuses a symbol that is not a coin, and reports Yahoo's own errors", async () => {
    const equity = JSON.parse(JSON.stringify(sample));
    equity.chart.result[0].meta.instrumentType = "EQUITY";
    await expect(fetchYahoo("SUI", 30, async () => equity, NOW)).rejects.toThrow(/not a coin.*SUI:/);
    await expect(fetchYahoo("NOPE", 30, async () => ({ chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }), NOW)).rejects.toThrow(/Not Found/);
    const h = await fetchYahoo("BTC", 30, async () => sample, NOW);
    expect(h).toMatchObject({ coin: "BTC", funding: [] });
    expect(h.source).toMatch(/yahoo BTC-USD.*spot.*funding assumed/);
  });
});
