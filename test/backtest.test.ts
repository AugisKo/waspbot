import { describe, expect, it } from "vitest";
import { BAR_MS, barsAt, lastAtOrBefore, type Row } from "../src/backtest/data.js";
import { HistoricalApi } from "../src/backtest/historical-api.js";
import { computeMetrics, dailyCloses, drawdown } from "../src/backtest/metrics.js";
import { htmlReport } from "../src/backtest/report.js";
import { runBacktest } from "../src/backtest/run.js";
import { syntheticHistory } from "../src/backtest/synthetic.js";

const T0 = Date.UTC(2026, 0, 1);
const M15 = BAR_MS["15m"];
const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => [T0 + i * M15, 100 + i, 101 + i, 99 + i, 100.5 + i, 1000]);

describe("no look-ahead", () => {
  it("15m bars: only those closed by now", () => {
    const r = rows(20);
    // At T0 + 10 bars, bars 0..9 have closed; bar 10 has just opened and must not be seen.
    const b = barsAt(r, M15, T0 + 10 * M15, 100);
    expect(b).toHaveLength(10);
    expect(b[b.length - 1]!.ts).toBe(T0 + 9 * M15);
    expect(b.every((x) => x.confirmed)).toBe(true);
  });

  it("1h bars: closed hours are confirmed, the current hour is built from closed 15m bars only", () => {
    const r = rows(20); // 5 hours of data
    const b = barsAt(r, BAR_MS["1H"], T0 + 6 * M15, 10); // 1h30 in: hour 0 closed, hour 1 has 2 closed quarters
    expect(b.map((x) => [x.ts, x.confirmed])).toEqual([[T0, true], [T0 + 3_600_000, false]]);
    expect(b[0]).toMatchObject({ o: 100, c: 103.5, h: 104, l: 99, volUsd: 4000 });
    expect(b[1]).toMatchObject({ o: 104, c: 105.5, volUsd: 2000 });
  });

  it("tickers and funding come from the past only", async () => {
    let now = T0 + 5 * M15;
    const api = new HistoricalApi([{ coin: "BTC", source: "t", candles: rows(20), funding: [[T0, 0.0002], [T0 + 8 * 3_600_000, 0.0009]] }], () => now, { spreadBps: 10, defaultFundingRate: 0.0001 });
    const t = (await api.tickers()).get("BTC-USD_UM_XPERP-BT")!;
    expect(t.last).toBe(104.5); // bar 4's close
    expect(t.ask - t.bid).toBeCloseTo(104.5 * 0.001, 8);
    expect((await api.funding("BTC-USD_UM_XPERP-BT")).rate).toBe(0.0002);
    now = T0 + 9 * 3_600_000;
    expect((await api.funding("BTC-USD_UM_XPERP-BT")).rate).toBe(0.0009);
    expect(lastAtOrBefore([1, 3, 5], 4, (x) => x)).toBe(1);
  });
});

describe("metrics", () => {
  it("drawdown, daily closes and trade stats", () => {
    const D = 86_400_000;
    const curve = [100, 110, 99, 105, 121].map((e, i) => ({ ts: T0 + i * D, equity: e }));
    expect(drawdown(curve).maxPct).toBeCloseTo(10, 8);
    expect(drawdown(curve).maxDays).toBe(2); // below the day-1 peak on days 2 and 3
    expect(dailyCloses([{ ts: T0, equity: 1 }, { ts: T0 + 1000, equity: 2 }, { ts: T0 + D, equity: 3 }]).map((p) => p.equity)).toEqual([2, 3]);
    const m = computeMetrics(curve, [{ openedAt: 0, closedAt: 3_600_000, pnlUsd: 30, r: 1.5 }, { openedAt: 0, closedAt: 7_200_000, pnlUsd: -10, r: -0.5 }], { feesUsd: 2, fundingUsd: -1, exposurePct: 50 });
    expect(m.totalReturnPct).toBeCloseTo(21, 8);
    expect(m).toMatchObject({ trades: 2, winRatePct: 50, avgR: 0.5, profitFactor: 3, avgHoldHours: 1.5, feeDragPct: 2 });
    expect(m.sharpe).not.toBeNull();
  });
});

describe("runBacktest", () => {
  it("replays the real engine on synthetic data and reports honestly", async () => {
    const histories = ["BTC", "ETH"].map((c, i) => syntheticHistory(c, { from: T0, days: 24, startPx: c === "BTC" ? 90_000 : 3_000, seed: 7 + i, volUsdPerBar: 5e6 }));
    const r = await runBacktest("rules", { histories, split: 0.5 });
    expect(r.engine).toBe("rules");
    expect(r.curve.length).toBeGreaterThan(1000);
    expect(r.curve[0]!.equity).toBeCloseTo(999, 0);
    expect(r.wasps.map((w) => w.name)).toEqual(["Jacket", "Vespa", "Hornet"]);
    expect(r.baseline?.coin).toBe("BTC");
    expect(r.split).not.toBeNull();
    expect(r.decisions).toBeGreaterThan(0);
    // Every trade pays fees; a random walk with no drift gives the rules no edge, so a big positive result would
    // mean the engine saw the future.
    expect(r.portfolio.feesUsd).toBeGreaterThanOrEqual(0);
    expect(r.portfolio.totalReturnPct).toBeLessThan(15);
    const html = htmlReport([r]);
    expect(html).toMatch(/<title>WaspBot backtest<\/title>/);
    expect(html).not.toMatch(/<script/);
  }, 120_000);

  it("never asks a model without a spend cap", async () => {
    const histories = [syntheticHistory("BTC", { from: T0, days: 12, startPx: 90_000, seed: 3, volUsdPerBar: 5e6 })];
    const r = await runBacktest("model", { histories, env: { DECISION_ENGINE: "llm", ANTHROPIC_API_KEY: "sk-ant-not-used-xx" }, maxLlmUsd: 0 });
    expect(r.engine).toBe("rules");
    expect(r.llmUsd).toBe(0);
    expect(r.notes.join(" ")).toMatch(/max-llm-usd is 0/);
    expect(r.settings).not.toHaveProperty("ANTHROPIC_API_KEY");
  }, 60_000);
});
