// The deterministic risk layer (hard rule 2: the chooser picks, code decides).
// Pure: no I/O, no clock, no randomness. Every veto, shrink and force says why.
// On top of each wasp's own caps it applies portfolio-level rules (a drawdown breaker, a net-exposure cap, a limit on
// wasps crowding into one coin), closes positions when market data has gone stale, keeps trend-following styles out of
// the wrong market regime, and lets the knowledge layer (news digest, event calendar, trade memory) veto or shrink an
// opening move. Nothing here ever opens a position on its own: a wasp with no setup stays flat.

import { MARGIN_HEADROOM, maxNotionalUsd, minutesSince, positionNotional } from "./bees/common.js";
import { coinOf, type Action, type BeeBrain, type BeeContext, type CapReason, type Intent, type Side } from "./bees/types.js";
import { regimeVeto } from "./market/regime.js";

export type { Action } from "./bees/types.js";

export interface Proposal {
  label: string;
  intent: Intent;
  /** Probability for the chosen label. */
  prob: number;
  /** Conviction level, rounded to 0..3. */
  conviction: number;
}

/** "no_options": the menu was empty, so Jev was not asked (forcing rules still apply). */
export type JevStatus = "ok" | "unreachable" | "daily_cap" | "no_options";

export interface RiskInput {
  ctx: BeeContext;
  brain: BeeBrain;
  /** null when Jev was not asked or did not answer. */
  proposal: Proposal | null;
  jev: JevStatus;
  /** 1, or LIVE_SIZE_MULTIPLIER during the live ramp. */
  sizeMult: number;
  /** Age of the last full market refresh. */
  dataAgeMs: number;
  maxDataAgeMs: number;
  /** Market data older than this closes any open position (0 = off). */
  staleFlattenMs?: number;
  /** Portfolio-level state across all wasps (absent = no portfolio rules, e.g. in older tests). */
  portfolio?: PortfolioState;
  /** Keep trend-following styles out of the wrong regime (market/regime.ts). */
  regimeFilter?: boolean;
  /** The knowledge layer's verdict on an opening move. It may veto or shrink, never open. */
  knowledge?: (instId: string, side: Side) => KnowledgeVerdict;
}

export interface PortfolioState {
  /** Set while the portfolio breaker is tripped: every wasp goes flat and opens nothing. */
  halted: string | null;
  /** Equity of all wasps together. */
  totalEquityUsd: number;
  /** Signed notional of the OTHER wasps (long +, short -). */
  othersNetUsd: number;
  /** Max |net notional| across all wasps, as a multiple of total equity. */
  netExposureMaxX: number;
  /** How many OTHER wasps hold each coin, per side. */
  othersByCoin: Record<string, { long: number; short: number }>;
  /** Max wasps in the same coin on the same side (this one included). */
  sameCoinMax: number;
}

export interface KnowledgeVerdict {
  veto: string | null;
  /** 0..1. 1 = no change. */
  sizeMult: number;
  /** Short reasons for the dashboard ("CPI in 40m", "news: exploit"). */
  notes: string[];
}

export interface RiskResult {
  action: Action;
  /** Why Jev's choice was not followed as-is. */
  vetoedBy: string | null;
  /** Code forced this action (stop, cap, max-flat...). */
  forcedBy: string | null;
  /** The bee's cap after this check. */
  cap: CapReason | null;
  /** Cap that tripped on this tick (fire an alert + banner). */
  capTripped: CapReason | null;
  /** One line for the dashboard. */
  status: string;
}

const NONE: Action = { kind: "none" };
const isOpening = (i: Intent) => i.kind === "open" || i.kind === "switch" || i.kind === "add";

/** Cap state for a bee, and whether one newly tripped. Caps only escalate within a day. */
export function evaluateCaps(ctx: BeeContext): { cap: CapReason | null; tripped: CapReason | null } {
  const { bee, cfg, knobs } = ctx;
  let cap = bee.cap;
  const set = (c: CapReason) => {
    const tripped = cap === c ? null : c;
    cap = c;
    return tripped;
  };
  if (cap === "retired") return { cap, tripped: null };
  if (bee.equityUsd <= cfg.risk.startEquityUsd * (cfg.risk.retireAtPct / 100)) return { cap: "retired", tripped: set("retired") };
  if (cap === "loss_stop") return { cap, tripped: null };
  if (bee.equityUsd <= bee.dayStartEquityUsd * (1 - cfg.risk.dailyLossStopPct / 100)) return { cap: "loss_stop", tripped: set("loss_stop") };
  if (cap) return { cap, tripped: null };
  if (bee.tradesToday >= knobs.maxTradesPerDay) return { cap: "trade_cap", tripped: set("trade_cap") };
  if (bee.feesTodayUsd >= knobs.feeBudgetUsdDay) return { cap: "fee_budget", tripped: set("fee_budget") };
  return { cap: null, tripped: null };
}

/** Benched bees ride: only a stop (or the loss stop) closes the position before the 00:00 UTC reset. */
const riding = (ctx: BeeContext) => (ctx.bee.position ? `riding its ${ctx.bee.position.coin} until the stop or 00:00 UTC` : "back at 00:00 UTC");

export function capStatus(cap: CapReason, ctx: BeeContext): string {
  switch (cap) {
    case "retired":
      return "retired for good (equity below the retire line)";
    case "loss_stop":
      return "sent home: daily loss stop, flat until 00:00 UTC";
    case "trade_cap":
      return `benched: all ${ctx.knobs.maxTradesPerDay} trade${ctx.knobs.maxTradesPerDay === 1 ? "" : "s"} used today, ${riding(ctx)}`;
    case "fee_budget":
      return `benched: fee budget gone ($${ctx.bee.feesTodayUsd.toFixed(2)} of $${ctx.knobs.feeBudgetUsdDay.toFixed(2)}), ${riding(ctx)}`;
  }
}

interface OpenCheck {
  ok: boolean;
  why?: string;
  notionalUsd?: number;
}

/** Room left under the portfolio's net-exposure cap for this wasp's position on `side`, in USD notional. */
function exposureRoom(input: RiskInput, side: Side, keepOwnUsd: number): number {
  const pf = input.portfolio;
  if (!pf) return Infinity;
  const limit = pf.netExposureMaxX * Math.max(0, pf.totalEquityUsd);
  const dir = side === "long" ? 1 : -1;
  // |others + own| <= limit  =>  own (in `side` direction) <= limit - dir x others
  return Math.max(0, limit - dir * pf.othersNetUsd - keepOwnUsd);
}

/** Portfolio, regime and knowledge gates shared by opens, switches and adds. Returns a veto, or the size multiplier. */
function portfolioGates(input: RiskInput, instId: string, side: Side, isAdd: boolean): { why: string } | { mult: number; notes: string[] } {
  const { brain, ctx } = input;
  const coin = coinOf(instId);
  const pf = input.portfolio;
  if (pf && !isAdd) {
    const o = pf.othersByCoin[coin];
    if (o && o[side] + 1 > pf.sameCoinMax) return { why: `crowded ${coin} ${side} (${o[side]} other wasp${o[side] === 1 ? "" : "s"})` };
  }
  if (input.regimeFilter && !isAdd) {
    const r = ctx.view.stats.get(instId)?.regime;
    const v = regimeVeto(brain.id, side, r);
    if (v) return { why: v };
  }
  if (input.knowledge) {
    const k = input.knowledge(instId, side);
    if (k.veto) return { why: `knowledge: ${k.veto}` };
    return { mult: Math.max(0, Math.min(1, k.sizeMult)), notes: k.notes };
  }
  return { mult: 1, notes: [] };
}

/** Spread gate, funding veto, min size and the size cap for an open/switch/add. */
function checkOpen(intent: Intent, input: RiskInput, conviction: number): OpenCheck {
  const { ctx, brain, sizeMult } = input;
  const { bee, view, knobs, cfg } = ctx;
  const max = maxNotionalUsd(ctx) * sizeMult;
  if (!(max > 0)) return { ok: false, why: "no_equity" };

  if (intent.kind === "add") {
    const p = bee.position!;
    const s = view.stats.get(p.instId);
    const inst = view.instruments.get(p.instId);
    if (!s || !inst) return { ok: false, why: "no_market_data" };
    if (s.spreadBp > knobs.spreadGateBps) return { ok: false, why: `spread_gate ${p.coin} ${s.spreadBp.toFixed(1)}bp` };
    // Cap add room against realised collateral (min of equityUsd and cashUsd) so unbooked uPnL never causes OKX 51008 rejections.
    const collateralUsd = Math.max(0, Math.min(bee.equityUsd, bee.cashUsd));
    const addMax = Math.min(cfg.risk.maxLeverage * collateralUsd * MARGIN_HEADROOM, cfg.risk.maxNotionalUsdPerBee) * sizeMult;
    const held = positionNotional(p, s.mid, inst.ctVal);
    const room = addMax - held;
    const g = portfolioGates(input, p.instId, p.side, true);
    if ("why" in g) return { ok: false, why: g.why };
    const n = Math.min(intent.sizeFrac * addMax * g.mult, room, exposureRoom(input, p.side, held));
    const minUsd = inst.minSz * inst.ctVal * s.mid;
    if (n < minUsd) return { ok: false, why: "size_cap" };
    return { ok: true, notionalUsd: n };
  }
  if (intent.kind !== "open" && intent.kind !== "switch") return { ok: false, why: "not_opening" };

  const s = view.stats.get(intent.instId);
  const inst = view.instruments.get(intent.instId);
  if (!s || !inst) return { ok: false, why: "no_market_data" };
  if (s.spreadBp > knobs.spreadGateBps) return { ok: false, why: `spread_gate ${s.coin} ${s.spreadBp.toFixed(1)}bp` };
  if (intent.side === "long" && brain.fundingVetoLongZ !== undefined && s.fundingZ !== null && s.fundingZ > brain.fundingVetoLongZ) {
    return { ok: false, why: `funding_veto ${s.coin} z=${s.fundingZ.toFixed(1)}` };
  }
  const g = portfolioGates(input, intent.instId, intent.side, false);
  if ("why" in g) return { ok: false, why: g.why };
  const frac = Math.max(0, Math.min(1, brain.sizeFrac(intent, conviction, ctx)));
  // A switch closes the current position first, so its notional does not count against the room.
  const n = Math.min(frac * max * g.mult, max, exposureRoom(input, intent.side, 0));
  const minUsd = inst.minSz * inst.ctVal * s.mid;
  if (n < minUsd) return { ok: false, why: n < frac * max * g.mult ? `exposure_cap ${s.coin} room $${n.toFixed(0)}` : `below_min_size ${s.coin} $${n.toFixed(2)} < $${minUsd.toFixed(2)}` };
  return { ok: true, notionalUsd: n };
}

function toAction(intent: Intent, notionalUsd?: number): Action {
  switch (intent.kind) {
    case "hold":
      return NONE;
    case "close":
      return { kind: "close", reason: intent.reason };
    case "trim":
      return { kind: "trim", fraction: intent.fraction };
    case "add":
      return { kind: "add", notionalUsd: notionalUsd! };
    case "open":
      return { kind: "open", instId: intent.instId, side: intent.side, notionalUsd: notionalUsd! };
    case "switch":
      return { kind: "switch", instId: intent.instId, side: intent.side, notionalUsd: notionalUsd! };
  }
}

export function applyRisk(input: RiskInput): RiskResult {
  const { ctx, brain, proposal, jev } = input;
  const { bee, view, knobs, now } = ctx;
  const p = bee.position;
  const { cap, tripped } = evaluateCaps(ctx);
  const out = (action: Action, extra: Partial<RiskResult> & { status: string }): RiskResult => ({
    action,
    vetoedBy: null,
    forcedBy: null,
    cap,
    capTripped: tripped,
    ...extra,
  });

  // 1. Retired / daily loss stop: go flat and stay flat. Forcing is suspended.
  if (cap === "retired" || cap === "loss_stop") {
    const status = capStatus(cap, ctx);
    if (p) return out({ kind: "close", reason: cap }, { forcedBy: cap, vetoedBy: proposal ? cap : null, status });
    return out(NONE, { vetoedBy: proposal ? cap : null, status });
  }

  // 1b. Portfolio breaker: every wasp goes flat and stays flat until the owner resumes.
  if (input.portfolio?.halted) {
    const status = `portfolio halted: ${input.portfolio.halted}`;
    if (p) return out({ kind: "close", reason: "portfolio_halt" }, { forcedBy: "portfolio_halt", vetoedBy: proposal ? "portfolio_halt" : null, status });
    return out(NONE, { vetoedBy: proposal ? "portfolio_halt" : null, status });
  }

  // 1c. Market data gone stale (feed down): a wasp does not hold a position it cannot see.
  if (p && input.staleFlattenMs && input.staleFlattenMs > 0 && input.dataAgeMs > input.staleFlattenMs) {
    return out({ kind: "close", reason: "stale_data" }, { forcedBy: "stale_data", vetoedBy: proposal ? "stale_data" : null, status: `market data ${Math.round(input.dataAgeMs / 60_000)} min old: closing ${p.coin}` });
  }

  // 2. Code stops fire whatever the chooser says, and even when it is down.
  if (p) {
    const s = view.stats.get(p.instId);
    if (s && p.stopPx !== null) {
      const hit = p.side === "long" ? s.mid <= p.stopPx : s.mid >= p.stopPx;
      if (hit) return out({ kind: "close", reason: "stop" }, { forcedBy: "stop", vetoedBy: proposal ? "stop" : null, status: `stopped out of ${p.coin}` });
    }
    const ts = brain.timeStopMinutes?.(ctx);
    if (ts !== undefined && minutesSince(p.openedAt, now) >= ts) {
      return out({ kind: "close", reason: "time_stop" }, { forcedBy: "time_stop", vetoedBy: proposal ? "time_stop" : null, status: `time stop on ${p.coin}` });
    }
  }

  // 3. Jev fail-closed: hold whatever we have, open nothing.
  if (jev === "daily_cap") return out(NONE, { vetoedBy: "jev_daily_cap", status: "model daily cap hit: all wasps hold" });
  if (jev === "unreachable" || (jev === "ok" && !proposal)) return out(NONE, { vetoedBy: "jev_unreachable", status: "Jev unreachable: holding" });

  let intent: Intent = proposal?.intent ?? { kind: "hold" };
  let vetoedBy: string | null = null;
  let notionalUsd: number | undefined;
  const veto = (why: string) => {
    vetoedBy = why;
    intent = { kind: "hold" };
  };

  // 4. Menu sanity: the intent must fit the position we actually have.
  if (!p && intent.kind !== "open" && intent.kind !== "hold") veto("invalid_while_flat");
  if (p && intent.kind === "open") veto("invalid_while_positioned");
  if (p && intent.kind === "switch" && intent.instId === p.instId && intent.side === p.side) veto("switch_to_same");

  const cooldownLeft = bee.lastOrderAt === null ? 0 : knobs.cooldownMinutes - minutesSince(bee.lastOrderAt, now);

  // 5. Opening gates.
  if (proposal && isOpening(intent)) {
    const dataStale = input.dataAgeMs > input.maxDataAgeMs;
    if (cap === "trade_cap" || cap === "fee_budget") veto(cap);
    else if (dataStale) veto("stale_market_data");
    else if (brain.openGate && intent.kind !== "add" && (proposal.prob < brain.openGate.minProb(ctx) || proposal.conviction < brain.openGate.minConviction)) {
      veto(`weak_conviction p=${proposal.prob.toFixed(2)} c=${proposal.conviction}`);
    } else if (brain.requiresStrictSetup && (intent.kind === "open" || intent.kind === "switch") && intent.setup === "loose") veto("no_setup_yet");
    else if (cooldownLeft > 0) veto(`cooldown ${Math.ceil(cooldownLeft)}m`);
    else {
      const c = checkOpen(intent, input, proposal.conviction);
      if (c.ok) notionalUsd = c.notionalUsd;
      else veto(c.why!);
    }
  }

  let action = toAction(intent, notionalUsd);
  let forcedBy: string | null = null;
  let status = !proposal ? (brain.idleStatus?.(ctx) ?? "no valid options") : vetoedBy ? `wanted ${proposal.label}, code said no: ${vetoedBy}` : proposal.label;

  // 6. Flat with nothing to do: say why. Nothing is ever forced open (the old "never flat for long" rule is gone).
  if (!p && action.kind === "none") {
    const flatMin = minutesSince(bee.flatSince, now);
    if (cap) status = capStatus(cap, ctx);
    else if (input.dataAgeMs > input.maxDataAgeMs) status = "stale market data: waiting";
    else if (cooldownLeft > 0 && !vetoedBy) status = `cooling down (${Math.ceil(cooldownLeft)}m left)`;
    else if (proposal && !vetoedBy) status = `${status} (flat ${flatMin.toFixed(0)} min)`;
  }
  if (p && action.kind === "none" && cap) status = capStatus(cap, ctx);

  // 7. Sizing is code's job: when holding an undersized position, bring it back to target (not while capped or stale).
  if (p && action.kind === "none" && !cap && brain.rebalance && input.dataAgeMs <= input.maxDataAgeMs) {
    const add = brain.rebalance(ctx);
    const c = add ? checkOpen(add, input, 0) : null;
    if (add && c?.ok) {
      action = toAction(add, c.notionalUsd);
      forcedBy = "rebalance";
      status = `sized up to target (+$${c.notionalUsd!.toFixed(0)})`;
    }
  }

  return { action, vetoedBy, forcedBy, cap, capTripped: tripped, status };
}
