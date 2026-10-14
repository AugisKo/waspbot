import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { LIVE_ACK_PHRASE } from "../src/config.js";
import type { Settings } from "../src/settings.js";
import { composeEnv, diffConfig, effectiveConfig } from "../src/tools/effective-config.js";

const intended = JSON.parse(readFileSync(new URL("../strategies/ARGON_INTENDED.json", import.meta.url), "utf8")) as Record<string, unknown>;
// Made-up values in each secret's shape, so a leak of any of them would show.
const SECRETS = {
  GEMINI_API_KEY: "AQ.Xx0Fakeexampleexampleexampleexampleexample1234567",
  TYPESAFE_API_KEY: "jev-secret-value-xyz",
  OPENAI_API_KEY: "sk-example-openai-value",
  BEEKEEPER_WEBHOOK_URL: "https://hooks.zapier.com/hooks/catch/123/abcdef/",
  LAB_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
  ALERT_WEBHOOK_URL: "https://ntfy.sh/some-private-topic",
};

describe("effective-config tool", () => {
  it("never prints a secret value, prefix or length, only presence", () => {
    const out = JSON.stringify(effectiveConfig(composeEnv(SECRETS)));
    for (const v of Object.values(SECRETS)) expect(out).not.toContain(v);
    expect(out).not.toMatch(/AQ\.|zapier|ntfy|jev-secret|sk-example/);
    expect(JSON.parse(out)).toMatchObject({ chooser: { provider: "gemini", apiKeyPresent: true }, keys: { gemini: true, jev: true, openai: true }, keeper: { hookFromEnv: true }, lab: { secretPresent: true }, alerts: { webhookPresent: true } });
  });

  it("keys from the Setup file count, and still show as presence only", () => {
    const s: Settings = {
      version: 1,
      geminiKey: "AQ.setup-file-gemini-key-value",
      acceptedRiskAt: 1,
      createdAt: 1,
      bees: [0, 1, 2].map((i) => ({ name: `Bee ${i}`, style: "boozy" as const, tagline: "", rules: "", coins: [], image: false })),
    };
    const out = JSON.stringify(effectiveConfig(composeEnv({}), s));
    expect(out).not.toContain("setup-file-gemini-key-value");
    expect(JSON.parse(out)).toMatchObject({ chooser: { provider: "gemini", apiKeyPresent: true }, slots: { bee1: "boozy" } });
  });

  it("live OKX keys show as presence only", () => {
    const env: Record<string, string> = { DRY_RUN: "false", MODE: "live", LIVE_ACK: LIVE_ACK_PHRASE, GEMINI_API_KEY: SECRETS.GEMINI_API_KEY };
    for (const b of ["BEE1", "BEE2", "BEE3"]) for (const f of ["KEY", "SECRET", "PASSPHRASE"]) env[`${b}_OKX_API_${f}`] = `${b}-${f}-value`;
    const out = JSON.stringify(effectiveConfig(composeEnv(env)));
    expect(out).not.toMatch(/-value/);
    expect(JSON.parse(out).keys.bee3).toEqual({ okxLive: true, okxDemo: false });
  });

  it("a clean env with the Gemini key matches Argon's intended config exactly", () => {
    expect(diffConfig(effectiveConfig(composeEnv({ GEMINI_API_KEY: SECRETS.GEMINI_API_KEY })), intended)).toEqual([]);
  });

  it("an old .env copied from the previous .env.example is caught knob by knob", () => {
    const old = { GEMINI_API_KEY: SECRETS.GEMINI_API_KEY, BIZZY_MAX_TRADES_PER_DAY: "1", BOOZY_SPREAD_GATE_BPS: "15", BOOZY_MAX_FLAT_MINUTES: "0", BREEZY_MIN_OPEN_PROB: "0.7", MAX_FLAT_MINUTES: "30" };
    const eff = effectiveConfig(composeEnv(old));
    expect(diffConfig(eff, intended).map((d) => d.knob).sort()).toEqual([
      "bees.bizzy.maxFlatMinutes",
      "bees.bizzy.maxTradesPerDay",
      "bees.boozy.maxFlatMinutes",
      "bees.boozy.spreadGateBps",
      "bees.breezy.maxFlatMinutes",
      "breezy.minOpenProb",
      "risk.maxFlatMinutes",
    ]);
    expect(eff.pinnedInEnv).toEqual(expect.arrayContaining(["BIZZY_MAX_TRADES_PER_DAY", "BOOZY_SPREAD_GATE_BPS", "MAX_FLAT_MINUTES"]));
  });

  it("a Jev-only or keyless install shows the chooser as a difference, not an error, on paper", () => {
    const jev = diffConfig(effectiveConfig(composeEnv({ TYPESAFE_API_KEY: "jev-key" })), intended).map((x) => x.knob);
    expect(jev).toEqual(expect.arrayContaining(["chooser.provider", "chooser.model"]));
    const none = diffConfig(effectiveConfig(composeEnv({})), intended).map((x) => x.knob);
    expect(none).toEqual(["chooser.provider", "chooser.apiKeyPresent"]);
  });

  it(".env.example, copied as is, sets exactly Argon's knobs (it pins every knob it lists)", () => {
    const example = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
    const diffs = diffConfig(effectiveConfig(composeEnv(example)), intended).map((d) => d.knob);
    // Only the key is missing from the example; every knob it pins matches.
    expect(diffs).toEqual(["chooser.provider", "chooser.apiKeyPresent"]);
    expect(diffConfig(effectiveConfig(composeEnv({ ...example, GEMINI_API_KEY: SECRETS.GEMINI_API_KEY })), intended)).toEqual([]);
  });

  it("the compose file's defaults apply when the env file leaves them out, and fixed entries always win", () => {
    const env = composeEnv({ TICK_MS: "5000", DB_PATH: "./elsewhere.sqlite" });
    expect(env).toMatchObject({ TICK_MS: "5000", DRY_RUN: "true", GEMINI_DAILY_USD_CAP: "3", DB_PATH: "/data/bees-{mode}.sqlite" });
  });

  it("live with no chooser key is a config error naming the variable only", () => {
    expect(() => effectiveConfig(composeEnv({ DRY_RUN: "false", MODE: "live", LIVE_ACK: LIVE_ACK_PHRASE }))).toThrow(/GEMINI_API_KEY/);
  });
});
