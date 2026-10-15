// pnpm backtest -- --coins BTC,ETH,SOL [--from 2026-06-01] [--to 2026-10-01] [--compare regime|engine|memory]
//                  [--split 0.7] [--set KEY=VALUE ...] [--engine rules|llm --max-llm-usd 5] [--synthetic] [--events data/events.json]
// Replays the real engine over stored history (pnpm backtest:fetch) and writes a report to data/backtest/reports/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadHistory, type CoinHistory } from "../backtest/data.js";
import { consoleReport, htmlReport } from "../backtest/report.js";
import { runBacktest, type BacktestOpts, type BacktestResult } from "../backtest/run.js";
import { syntheticHistory } from "../backtest/synthetic.js";
import { loadEventsFile } from "../knowledge/calendar.js";
import { setLogLevel } from "../log.js";

function args(argv: string[]) {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true";
    (out[k] ??= []).push(v);
  }
  return out;
}

const a = args(process.argv.slice(2));
const one = (k: string) => a[k]?.[a[k]!.length - 1];
if (a.help) {
  process.stdout.write(`Usage: pnpm backtest -- --coins BTC,ETH,SOL [options]
  --data DIR            history folder (default data/backtest/history)
  --synthetic           use generated data instead (pipeline check only, says nothing about markets)
  --from / --to         YYYY-MM-DD (default: everything stored, after a 10-day warm-up)
  --compare X           regime | engine | memory: run with it on and off, side by side
  --set KEY=VALUE       any .env knob, repeatable (e.g. --set NET_EXPOSURE_MAX_X=0.5)
  --engine rules|llm    default rules; llm needs a model key in the environment AND --max-llm-usd
  --max-llm-usd N       hard cap on model spend for the whole run
  --split 0.7           report in-sample vs out-of-sample (the last 30%)
  --events FILE         event calendar to apply (same format as data/events.json)
  --spread-bps N        bid/ask spread around each close (default 2)
  --slippage-bps N      extra adverse slippage per fill (default 2)
  --out DIR             report folder (default data/backtest/reports)
`);
  process.exit(0);
}

setLogLevel("error");
// Commas or spaces: PowerShell turns BTC,ETH,SOL into "BTC ETH SOL".
const coins = (one("coins") ?? "BTC,ETH,SOL").split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
const dataDir = one("data") ?? "./data/backtest/history";
const histories: CoinHistory[] = a.synthetic
  ? coins.map((c, i) => syntheticHistory(c, { from: Date.UTC(2026, 0, 1), days: Number(one("days") ?? 120), startPx: c === "BTC" ? 90_000 : c === "ETH" ? 3_000 : 150 / (i + 1), seed: 1000 + i, volUsdPerBar: 5e6 }))
  : coins.map((c) => loadHistory(dataDir, c));

const sets: Record<string, string> = {};
for (const kv of a.set ?? []) {
  const i = kv.indexOf("=");
  if (i > 0) sets[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
}
const engine = one("engine") ?? "rules";
// Model keys come from the environment only when a model run was asked for.
const keys = engine === "llm" ? Object.fromEntries(["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TYPESAFE_API_KEY", "LLM_PROVIDER", "ANTHROPIC_MODEL", "GEMINI_MODEL", "OPENAI_DECISION_MODEL"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])) : {};
const base: BacktestOpts = {
  histories,
  ...(one("from") ? { from: Date.parse(`${one("from")}T00:00:00Z`) } : {}),
  ...(one("to") ? { to: Date.parse(`${one("to")}T00:00:00Z`) } : {}),
  env: { ...keys, ...sets, DECISION_ENGINE: engine },
  spreadBps: Number(one("spread-bps") ?? 2),
  slippageBps: Number(one("slippage-bps") ?? 2),
  maxLlmUsd: Number(one("max-llm-usd") ?? 0),
  ...(one("split") ? { split: Number(one("split")) } : {}),
  ...(one("events") ? { events: loadEventsFile(one("events")!) } : {}),
  onProgress: (f) => process.stderr.write(`\r${(f * 100).toFixed(0)}%   `),
};

const variants: Array<[string, BacktestOpts]> = [];
switch (one("compare")) {
  case "regime":
    variants.push(["regime filter on", { ...base, env: { ...base.env, REGIME_FILTER: "true" } }], ["regime filter off", { ...base, env: { ...base.env, REGIME_FILTER: "false" } }]);
    break;
  case "engine":
    variants.push(["rules", { ...base, env: { ...base.env, DECISION_ENGINE: "rules" } }], ["model", { ...base, env: { ...base.env, DECISION_ENGINE: "llm" } }]);
    break;
  case "memory":
    variants.push(["memory gate on", { ...base, memoryGate: true }], ["memory gate off", { ...base, memoryGate: false }]);
    break;
  default:
    variants.push([engine === "llm" ? "model" : "rules", base]);
}

const results: BacktestResult[] = [];
for (const [label, opts] of variants) {
  process.stderr.write(`running: ${label}\n`);
  results.push(await runBacktest(label, opts));
  process.stderr.write("\r");
}

const outDir = one("out") ?? "./data/backtest/reports";
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const name = `backtest-${stamp}${a.synthetic ? "-synthetic" : ""}`;
writeFileSync(join(outDir, `${name}.json`), JSON.stringify(results.map((r) => ({ ...r, curve: undefined, baselineCurve: undefined })), null, 2));
writeFileSync(join(outDir, `${name}.html`), htmlReport(results));
process.stdout.write(`${consoleReport(results)}\n\nreport: ${join(outDir, `${name}.html`)}\n`);
