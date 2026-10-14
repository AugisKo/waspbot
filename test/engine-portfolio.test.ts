// Engine-level: the portfolio breaker and trade memory capture.
import { describe, expect, it } from "vitest";
import type { Alerts } from "../src/alerts.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Jev } from "../src/jev.js";
import { KnowledgeLayer } from "../src/knowledge/layer.js";
import { TradeMemory } from "../src/knowledge/memory.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, position, testConfig, view } from "./fixtures.js";

function boot(env: Record<string, string> = {}) {
  const cfg = testConfig({ DRY_RUN: "true", DECISION_ENGINE: "rules", ...env });
  let now = NOW;
  const sol = coin("SOL");
  const v = view([sol]);
  const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, get lastRefreshAt() { return now; } } as unknown as MarketFeed;
  const db = new Db(":memory:");
  const memory = new TradeMemory(db);
  const knowledge = new KnowledgeLayer({ digests: null, calendar: null, memory, notes: null, enabled: () => ({ digest: false, calendar: false, memory: true, notes: false }), memoryMinSamples: 15, digestMaxAgeMs: 1, now: () => now });
  const alerts: string[] = [];
  const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, now: () => now }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate, () => now), bus: new EventBus(db), alerts: { send: (t: string) => alerts.push(t) } as unknown as Alerts, now: () => now, knowledge });
  return { engine, db, sol, v, memory, alerts, advance: (ms: number) => (now += ms), get now() { return now; } };
}

describe("portfolio breaker", () => {
  it("a drawdown from the peak flattens every wasp and holds until the owner resumes", async () => {
    const t = boot({ PORTFOLIO_MAX_DRAWDOWN_PCT: "10", PORTFOLIO_DAILY_LOSS_PCT: "50" });
    await t.engine.start();
    t.engine.stop();
    await t.engine.tick();
    expect(t.engine.snapshot().portfolio.halted).toBeNull();
    // bee3 holds SOL; equity of every wasp drops 12%.
    const b3 = t.engine.bees.bee3;
    b3.position = position(t.sol, { contracts: 50, stopPx: null });
    for (const id of ["bee1", "bee2", "bee3"] as const) t.engine.bees[id].cashUsd = 333 * 0.88;
    t.advance(10_000);
    await t.engine.tick();
    const halt = t.engine.snapshot().portfolio.halted;
    expect(halt).toMatchObject({ kind: "drawdown" });
    expect(t.alerts.some((a) => a.startsWith("portfolio halted"))).toBe(true);
    expect(t.engine.bees.bee3.position).toBeNull();
    // Still halted on later ticks, a day later too.
    t.advance(26 * 3_600_000);
    await t.engine.tick();
    expect(t.engine.snapshot().portfolio.halted).toMatchObject({ kind: "drawdown" });
    expect(t.engine.resumePortfolio()).toBe(true);
    await t.engine.tick();
    expect(t.engine.snapshot().portfolio.halted).toBeNull();
    expect(t.engine.resumePortfolio()).toBe(false);
  });

  it("a day's loss halts until 00:00 UTC, then clears by itself", async () => {
    const t = boot({ PORTFOLIO_MAX_DRAWDOWN_PCT: "50", PORTFOLIO_DAILY_LOSS_PCT: "5" });
    await t.engine.start();
    t.engine.stop();
    await t.engine.tick();
    for (const id of ["bee1", "bee2", "bee3"] as const) t.engine.bees[id].cashUsd = 333 * 0.94;
    t.advance(10_000);
    await t.engine.tick();
    expect(t.engine.snapshot().portfolio.halted).toMatchObject({ kind: "daily" });
    t.advance(13 * 3_600_000); // past 00:00 UTC
    await t.engine.tick();
    expect(t.engine.snapshot().portfolio.halted).toBeNull();
  });
});

describe("trade memory capture", () => {
  it("a closed trade lands in memory with its net P&L in R and its entry picture", async () => {
    const t = boot();
    await t.engine.start();
    t.engine.stop();
    const b3 = t.engine.bees.bee3;
    // An open trade as the engine leaves it: 1R = $10, $0.05 fee paid at entry, entry features saved.
    b3.position = position(t.sol, { contracts: 100, entryPx: 100, stopPx: 105, risk0Usd: 10, tradeNetUsd: -0.05, entryFeatures: { regime: "trend", regimeDir: 1, adx: 30, er: 0.5, rsi14: 60, ret24hPct: 2, atr14Pct: 0.5, fundingZ: 0, volZ: 1, newsSentiment: null } });
    b3.flatSince = null;
    // The stop is above the price: the next tick closes it at a loss.
    await t.engine.tick();
    expect(b3.position).toBeNull();
    expect(t.memory.count()).toBe(1);
    const row = t.db.raw.prepare(`SELECT style, side, r_mult AS r, pnl_usd AS pnl, reason FROM trade_memory`).get() as { style: string; side: string; r: number; pnl: number; reason: string };
    expect(row).toMatchObject({ style: "boozy", side: "long", reason: "stop" });
    // Sold at the bid (100 x 0.99995) on $100 notional: -$0.005 realised, plus the two fees.
    expect(row.pnl).toBeLessThan(-0.05);
    expect(row.r).toBeCloseTo(row.pnl / 10, 10);
  });
});
