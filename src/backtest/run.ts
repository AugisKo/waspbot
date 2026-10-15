// The backtester: the real engine (same brains, same chooser, same risk layer, same ledger) replayed over stored
// history on a simulated clock, one 15-minute step at a time. Fills are taker fills at the bid/ask plus slippage, fees
// are charged, funding is paid every 8 hours. Nothing reads the future: every bar the engine sees has closed.
//
// What it cannot know: historical news (the news digest is off), intrabar stop fills (a stop is checked against each
// 15m close, so a gap through it fills at the close, usually worse), queue position and partial fills. With a model as
// the chooser, results are also contaminated: the model may have read about the very period it is trading.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Alerts } from "../alerts.js";
import { BREEZY_COINS } from "../bees/breezy.js";
import { BEES, loadConfig, STYLES, type BeeId, type Config } from "../config.js";
import { Db } from "../db.js";
import { Engine } from "../engine.js";
import { EventBus } from "../events.js";
import { SimExecutor } from "../exec/executor.js";
import { Jev } from "../jev.js";
import { EventCalendar, type CalendarEvent } from "../knowledge/calendar.js";
import { KnowledgeLayer } from "../knowledge/layer.js";
import { TradeMemory } from "../knowledge/memory.js";
import { MarketFeed } from "../market/data.js";
import { BAR_MS, type CoinHistory } from "./data.js";
import { HistoricalApi } from "./historical-api.js";
import { computeMetrics, window, type Metrics, type Point, type TradeRec } from "./metrics.js";

export interface BacktestOpts {
  histories: CoinHistory[];
  /** Simulated start and end (ms). Default: the whole common span, after the warm-up. */
  from?: number;
  to?: number;
  /** Days of history the indicators get before trading starts. Default 10. */
  warmupDays?: number;
  /** Environment overrides for the engine (any .env knob: DECISION_ENGINE, REGIME_FILTER, BIZZY_*, ...). */
  env?: Record<string, string>;
  spreadBps?: number;
  slippageBps?: number;
  defaultFundingRate?: number;
  /** Knowledge parts to use: the calendar (with these events) and trade memory as a size gate. */
  events?: CalendarEvent[];
  memoryGate?: boolean;
  /** Stop asking a model once this much has been spent (USD, whole run). Default 0 = never ask a model. */
  maxLlmUsd?: number;
  /** In-sample share for a split report (0 < split < 1). */
  split?: number;
  /** Progress callback (fraction 0..1). */
  onProgress?: (f: number) => void;
}

export interface WaspResult {
  id: BeeId;
  name: string;
  style: string;
  metrics: Metrics;
}

export interface BacktestResult {
  label: string;
  from: number;
  to: number;
  coins: string[];
  engine: string;
  settings: Record<string, string>;
  portfolio: Metrics;
  wasps: WaspResult[];
  baseline: { coin: string; metrics: Metrics } | null;
  split: { at: number; inSample: Metrics; outOfSample: Metrics } | null;
  curve: Point[];
  baselineCurve: Point[];
  trades: Array<TradeRec & { wasp: string; coin: string; side: string; reason: string | null }>;
  llmUsd: number;
  decisions: number;
  notes: string[];
}

const quietAlerts = { send: () => {} } as unknown as Alerts;

export async function runBacktest(label: string, o: BacktestOpts): Promise<BacktestResult> {
  if (!o.histories.length) throw new Error("no coin histories");
  const dir = mkdtempSync(join(tmpdir(), "waspbot-bt-"));
  const env: Record<string, string> = {
    DRY_RUN: "true",
    DECISION_ENGINE: "rules",
    DB_PATH: join(dir, "bt.sqlite"),
    SETTINGS_PATH: join(dir, "settings.json"),
    TICK_MS: String(BAR_MS["15m"]),
    DATA_REFRESH_MS: String(BAR_MS["15m"]),
    STALE_FLATTEN_MINUTES: "0",
    LOG_LEVEL: "error",
    ...(o.env ?? {}),
  };
  const cfg: Config = loadConfig(env);
  let now = 0;
  const clock = () => now;
  const api = new HistoricalApi(o.histories, clock, { spreadBps: o.spreadBps ?? 2, defaultFundingRate: o.defaultFundingRate ?? 0.0001 });
  const span = api.span();
  const warm = (o.warmupDays ?? 10) * 86_400_000;
  const step = BAR_MS["15m"];
  const from = Math.ceil(Math.max(o.from ?? 0, span.from + warm) / step) * step;
  const to = Math.min(o.to ?? Infinity, span.to);
  if (!(to > from + step)) throw new Error(`not enough history: need at least ${o.warmupDays ?? 10} warm-up days plus the test window`);

  const db = new Db(":memory:");
  const bus = new EventBus(db);
  let engine: Engine | null = null;
  const held = () => (engine ? BEES.map((id) => engine!.bees[id]?.position?.instId).filter((x): x is string => !!x) : []);
  const feed = new MarketFeed(api, { min24hVolUsd: cfg.universe.min24hVolUsd, allowNonCrypto: true, spreadGateBps: Math.max(...STYLES.map((s) => cfg.bees[s].spreadGateBps)), trendCoins: [...BREEZY_COINS] }, null, held);
  const exec = new SimExecutor(() => feed.view(), cfg.risk.takerFeeRate, clock, o.slippageBps ?? 2);
  const jev = new Jev({ ...cfg.jev, now: clock });
  const memory = new TradeMemory(db);
  const calendar = new EventCalendar({ path: join(dir, "none.json"), now: clock });
  calendar.set(o.events ?? []);
  const knowledge = new KnowledgeLayer({
    digests: null,
    calendar,
    memory,
    notes: null,
    enabled: () => ({ digest: false, calendar: (o.events?.length ?? 0) > 0, memory: !!o.memoryGate, notes: false }),
    memoryMinSamples: cfg.knowledge.memoryMinSamples,
    digestMaxAgeMs: 0,
    now: clock,
  });

  now = from;
  engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts: quietAlerts, now: clock, knowledge, controls: () => ({ regimeFilter: cfg.risk.regimeFilter }) });
  await engine.start();
  engine.stop(); // no timers: the loop below drives every refresh and tick

  const notes: string[] = [];
  const llmBudget = o.maxLlmUsd ?? 0;
  if (jev.engine === "llm" && jev.provider !== "code") {
    if (llmBudget <= 0) {
      jev.reconfigure({ engine: "rules" });
      notes.push("A model engine was asked for, but --max-llm-usd is 0: the rules engine ran instead.");
    } else notes.push(`Model engine ${jev.provider}/${jev.model}, capped at $${llmBudget} for the whole run. A model may have read about this period: treat its results with suspicion.`);
  }

  let haltSeen: string | null = null;
  const curve: Point[] = [];
  const perWasp: Record<BeeId, Point[]> = { bee1: [], bee2: [], bee3: [] };
  const inPos: Record<BeeId, number> = { bee1: 0, bee2: 0, bee3: 0 };
  let steps = 0;
  let llmUsd = 0;
  const total = Math.ceil((to - from) / step);
  for (now = from; now <= to; now += step) {
    await engine.refreshMarket();
    await engine.tick();
    let sum = 0;
    for (const id of BEES) {
      const b = engine.bees[id];
      perWasp[id].push({ ts: now, equity: b.equityUsd });
      sum += b.equityUsd;
      if (b.position) inPos[id]++;
    }
    curve.push({ ts: now, equity: sum });
    steps++;
    const h = engine.snapshot().portfolio.halted;
    if (h && haltSeen !== h.reason) {
      haltSeen = h.reason;
      notes.push(`Portfolio breaker tripped ${new Date(now).toISOString().slice(0, 16)}Z: ${h.reason}.${h.kind === "drawdown" ? " Live, the owner would decide whether to resume; the backtest stays halted." : ""}`);
    } else if (!h) haltSeen = null;
    if (jev.engine === "llm") {
      llmUsd = BEES.reduce((a, id) => a + engine!.bees[id].totals.jevUsd, 0);
      if (llmUsd >= llmBudget) {
        jev.reconfigure({ engine: "rules" });
        notes.push(`Model budget of $${llmBudget} used up at ${new Date(now).toISOString().slice(0, 16)}Z: the rules engine took over.`);
      }
    }
    if (o.onProgress && steps % 500 === 0) o.onProgress(steps / total);
  }

  const rows = db.raw.prepare(`SELECT wasp, coin, side, opened_at AS openedAt, closed_at AS closedAt, pnl_usd AS pnlUsd, r_mult AS r, reason FROM trade_memory ORDER BY closed_at`).all() as Array<{ wasp: string; coin: string; side: string; openedAt: number; closedAt: number; pnlUsd: number; r: number; reason: string | null }>;
  const trades = rows.map((t) => ({ ...t }));
  const decisions = Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM decisions`).get() as { n: number }).n);

  const wasps: WaspResult[] = BEES.map((id) => {
    const b = engine!.bees[id];
    const mine = trades.filter((t) => t.wasp === id);
    return {
      id,
      name: cfg.slots[id].name,
      style: cfg.slots[id].style,
      metrics: computeMetrics(perWasp[id], mine, { feesUsd: b.totals.feesUsd, fundingUsd: b.totals.fundingUsd, exposurePct: steps ? (inPos[id] / steps) * 100 : null }),
    };
  });
  const fees = BEES.reduce((a, id) => a + engine!.bees[id].totals.feesUsd, 0);
  const funding = BEES.reduce((a, id) => a + engine!.bees[id].totals.fundingUsd, 0);
  const exposure = steps ? (BEES.reduce((a, id) => a + inPos[id], 0) / (3 * steps)) * 100 : null;
  const portfolio = computeMetrics(curve, trades, { feesUsd: fees, fundingUsd: funding, exposurePct: exposure });

  // Buy and hold the first coin (BTC when present) with the same starting money, 1x, no fees after entry.
  const baseCoin = o.histories.find((h) => h.coin === "BTC")?.coin ?? o.histories[0]!.coin;
  const p0 = api.priceAt(baseCoin, from);
  const baselineCurve: Point[] = p0 ? curve.map((p) => ({ ts: p.ts, equity: (curve[0]!.equity * (api.priceAt(baseCoin, p.ts) ?? p0)) / p0 })) : [];
  const baseline = baselineCurve.length ? { coin: baseCoin, metrics: computeMetrics(baselineCurve, [], { feesUsd: 0, fundingUsd: 0, exposurePct: 100 }) } : null;

  let split: BacktestResult["split"] = null;
  if (o.split && o.split > 0 && o.split < 1) {
    const at = from + Math.floor(((to - from) * o.split) / step) * step;
    const tIn = trades.filter((t) => t.closedAt <= at);
    const tOut = trades.filter((t) => t.closedAt > at);
    split = {
      at,
      inSample: computeMetrics(window(curve, from, at), tIn, { feesUsd: NaN, fundingUsd: NaN, exposurePct: null }),
      outOfSample: computeMetrics(window(curve, at, to), tOut, { feesUsd: NaN, fundingUsd: NaN, exposurePct: null }),
    };
  }

  db.close();
  rmSync(dir, { recursive: true, force: true });
  const settings = Object.fromEntries(Object.entries(o.env ?? {}).filter(([k]) => !/KEY|SECRET|PASSPHRASE|TOKEN/i.test(k)));
  return {
    label,
    from,
    to,
    coins: o.histories.map((h) => h.coin),
    engine: jev.engine === "llm" ? `${jev.provider}:${jev.model}` : "rules",
    settings,
    portfolio,
    wasps,
    baseline,
    split,
    curve,
    baselineCurve,
    trades,
    llmUsd,
    decisions,
    notes,
  };
}
