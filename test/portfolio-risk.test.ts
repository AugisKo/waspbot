import { describe, expect, it } from "vitest";
import { boozy } from "../src/bees/boozy.js";
import { breezy } from "../src/bees/breezy.js";
import type { BeeBrain, BeeContext, Intent } from "../src/bees/types.js";
import type { Regime } from "../src/market/regime.js";
import { applyRisk, type JevStatus, type PortfolioState, type Proposal, type RiskInput } from "../src/risk.js";
import { bee, coin, ctx, NOW, position, view } from "./fixtures.js";

const open = (instId: string, side: "long" | "short" = "long"): Intent => ({ kind: "open", instId, side, sizeFrac: 1, setup: "strict" });
const prop = (intent: Intent): Proposal => ({ label: "X", intent, prob: 0.9, conviction: 3 });

function run(c: BeeContext, brain: BeeBrain, proposal: Proposal | null, extra: Partial<RiskInput> = {}, jev: JevStatus = "ok") {
  return applyRisk({ ctx: c, brain, proposal, jev, sizeMult: 1, dataAgeMs: 1000, maxDataAgeMs: 120_000, ...extra });
}

const pf = (over: Partial<PortfolioState> = {}): PortfolioState => ({
  halted: null,
  totalEquityUsd: 999,
  othersNetUsd: 0,
  netExposureMaxX: 1,
  othersByCoin: {},
  sameCoinMax: 2,
  ...over,
});

const SOL = coin("SOL");
const V = view([SOL]);

describe("portfolio breaker", () => {
  it("closes an open position and opens nothing while halted", () => {
    const held = bee("boozy", { position: position(SOL), flatSince: null });
    const r = run(ctx("boozy", held, V), boozy, null, { portfolio: pf({ halted: "drawdown 21% from peak" }) }, "no_options");
    expect(r.action).toEqual({ kind: "close", reason: "portfolio_halt" });
    expect(r.forcedBy).toBe("portfolio_halt");
    const flat = run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId)), { portfolio: pf({ halted: "x" }) });
    expect(flat.action.kind).toBe("none");
    expect(flat.vetoedBy).toBe("portfolio_halt");
  });
});

describe("stale data flatten", () => {
  it("closes a position when market data is older than the limit, and only then", () => {
    const held = bee("boozy", { position: position(SOL), flatSince: null });
    const stale = run(ctx("boozy", held, V), boozy, null, { dataAgeMs: 11 * 60_000, staleFlattenMs: 10 * 60_000 }, "no_options");
    expect(stale.action).toEqual({ kind: "close", reason: "stale_data" });
    const fresh = run(ctx("boozy", held, V), boozy, null, { dataAgeMs: 9 * 60_000, staleFlattenMs: 10 * 60_000 }, "no_options");
    expect(fresh.forcedBy).not.toBe("stale_data");
    const off = run(ctx("boozy", held, V), boozy, null, { dataAgeMs: 60 * 60_000, staleFlattenMs: 0 }, "no_options");
    expect(off.forcedBy).not.toBe("stale_data");
  });
});

describe("net exposure cap", () => {
  it("shrinks a long to the room left under the cap", () => {
    // Others are already net long $900 of a $999 cap: $99 of room.
    const r = run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId)), { portfolio: pf({ othersNetUsd: 900 }) });
    expect(r.action.kind).toBe("open");
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeCloseTo(99, 5);
  });

  it("vetoes when the room is below the minimum size", () => {
    const r = run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId)), { portfolio: pf({ othersNetUsd: 998.5 }) });
    expect(r.action.kind).toBe("none");
    expect(r.vetoedBy).toMatch(/exposure_cap/);
  });

  it("a short against a net-long book has more room, not less", () => {
    const r = run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId, "short")), { portfolio: pf({ othersNetUsd: 900 }) });
    expect(r.action.kind).toBe("open");
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeGreaterThan(99);
  });
});

describe("crowding", () => {
  it("vetoes a third wasp into the same coin and side", () => {
    const r = run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId)), { portfolio: pf({ othersByCoin: { SOL: { long: 2, short: 0 } } }) });
    expect(r.vetoedBy).toMatch(/crowded SOL long/);
    const other = run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId, "short")), { portfolio: pf({ othersByCoin: { SOL: { long: 2, short: 0 } } }) });
    expect(other.action.kind).toBe("open");
  });
});

describe("regime filter", () => {
  const regime = (r: Partial<Regime>): Regime => ({ kind: "range", dir: 0, adx: 15, er: 0.1, volPct: 0.5, ...r });

  it("keeps Momentum out of a range, and out of a trend the other way", () => {
    const range = view([{ ...SOL, regime: regime({}) }]);
    expect(run(ctx("boozy", bee("boozy"), range), boozy, prop(open(SOL.instId)), { regimeFilter: true }).vetoedBy).toMatch(/regime range/);
    const down = view([{ ...SOL, regime: regime({ kind: "trend", dir: -1, adx: 30, er: 0.5 }) }]);
    expect(run(ctx("boozy", bee("boozy"), down), boozy, prop(open(SOL.instId)), { regimeFilter: true }).vetoedBy).toMatch(/regime trend down vs long/);
    expect(run(ctx("boozy", bee("boozy"), down), boozy, prop(open(SOL.instId, "short")), { regimeFilter: true }).action.kind).toBe("open");
  });

  it("is off when the filter is off, and never vetoes with unknown regime", () => {
    const range = view([{ ...SOL, regime: regime({}) }]);
    expect(run(ctx("boozy", bee("boozy"), range), boozy, prop(open(SOL.instId)), { regimeFilter: false }).action.kind).toBe("open");
    expect(run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId)), { regimeFilter: true }).action.kind).toBe("open");
  });
});

describe("knowledge verdict", () => {
  it("can veto an open", () => {
    const r = run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId)), { knowledge: () => ({ veto: "event CPI (in 20m)", sizeMult: 0, notes: [] }) });
    expect(r.action.kind).toBe("none");
    expect(r.vetoedBy).toBe("knowledge: event CPI (in 20m)");
  });

  it("can shrink an open but never grow it", () => {
    const base = run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId)));
    const half = run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId)), { knowledge: () => ({ veto: null, sizeMult: 0.5, notes: ["news against long"] }) });
    const more = run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId)), { knowledge: () => ({ veto: null, sizeMult: 3, notes: [] }) });
    const n = (r: typeof base) => (r.action as { notionalUsd: number }).notionalUsd;
    expect(n(half)).toBeCloseTo(n(base) / 2, 5);
    expect(n(more)).toBeCloseTo(n(base), 5);
  });

  it("never opens anything by itself: no proposal, no open", () => {
    const r = run(ctx("breezy", bee("breezy", { flatSince: NOW - 48 * 3_600_000 }), V), breezy, null, { knowledge: () => ({ veto: null, sizeMult: 1, notes: [] }) }, "no_options");
    expect(r.action.kind).toBe("none");
    expect(r.forcedBy).toBeNull();
  });
});
