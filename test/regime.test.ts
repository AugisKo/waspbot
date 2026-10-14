import { describe, expect, it } from "vitest";
import { adx, classifyRegime, efficiencyRatio, regimeVeto, volPercentile } from "../src/market/regime.js";
import type { Candle } from "../src/market/types.js";

const H = 3_600_000;
function candles(closes: number[], wick = 0.002): Candle[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1]! : c;
    return { ts: i * H, o, h: Math.max(o, c) * (1 + wick), l: Math.min(o, c) * (1 - wick), c, volUsd: 1e6, confirmed: true };
  });
}

describe("regime", () => {
  it("a steady climb is an uptrend", () => {
    const c = candles(Array.from({ length: 120 }, (_, i) => 100 * 1.004 ** i));
    const r = classifyRegime(c);
    expect(r.kind).toBe("trend");
    expect(r.dir).toBe(1);
    expect(r.adx!).toBeGreaterThan(22);
    expect(efficiencyRatio(c.map((x) => x.c))!).toBeGreaterThan(0.9);
  });

  it("a steady fall is a downtrend", () => {
    const r = classifyRegime(candles(Array.from({ length: 120 }, (_, i) => 100 * 0.996 ** i)));
    expect(r).toMatchObject({ kind: "trend", dir: -1 });
  });

  it("a quiet zig-zag is a range", () => {
    const r = classifyRegime(candles(Array.from({ length: 120 }, (_, i) => 100 + (i % 2 ? 0.3 : -0.3))));
    expect(r.kind).toBe("range");
    expect(r.dir).toBe(0);
  });

  it("a zig-zag that suddenly gets wild is chop", () => {
    const quiet = Array.from({ length: 100 }, (_, i) => 100 + (i % 2 ? 0.2 : -0.2));
    const wild = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 ? 4 : -4));
    const r = classifyRegime(candles([...quiet, ...wild]));
    expect(r.kind).toBe("chop");
    expect(volPercentile(candles([...quiet, ...wild]))!).toBeGreaterThan(0.8);
  });

  it("needs enough bars, and unknown never vetoes", () => {
    expect(adx(candles([1, 2, 3]))).toBeNull();
    expect(regimeVeto("boozy", "long", null)).toBeNull();
    expect(regimeVeto("boozy", "long", { kind: "range", dir: 0, adx: null, er: null, volPct: null })).toBeNull();
  });

  it("styles: trend and momentum need a trend their way; breakout only avoids chop", () => {
    const up = { kind: "trend" as const, dir: 1 as const, adx: 30, er: 0.5, volPct: 0.5 };
    const chop = { kind: "chop" as const, dir: 0 as const, adx: 15, er: 0.1, volPct: 0.95 };
    const range = { kind: "range" as const, dir: 0 as const, adx: 15, er: 0.1, volPct: 0.4 };
    expect(regimeVeto("breezy", "long", up)).toBeNull();
    expect(regimeVeto("breezy", "short", up)).toMatch(/vs short/);
    expect(regimeVeto("boozy", "long", range)).toMatch(/range/);
    expect(regimeVeto("bizzy", "long", range)).toBeNull();
    expect(regimeVeto("bizzy", "short", chop)).toMatch(/chop/);
  });
});
