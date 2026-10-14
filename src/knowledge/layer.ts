// The knowledge layer: news digests, the event calendar, trade memory and the owner's notes, each one switchable.
// It gives the engine two things:
// - verdict(): may VETO or SHRINK an opening move (open, switch, add). It is applied in the risk layer after every other
//   gate, so it can only make a wasp more careful. It never opens, never closes, never moves a stop.
// - context(): a short text the model reads with each decision (the code chooser ignores it).
import { coinOf, type Side } from "../bees/types.js";
import type { MarketView } from "../market/types.js";
import type { KnowledgeVerdict } from "../risk.js";
import type { EventCalendar } from "./calendar.js";
import { SEVERE_FLAGS, type Digest, type DigestStore } from "./digest.js";
import { featuresOf, type ClosedTrade, type EntryFeatures, type TradeMemory } from "./memory.js";
import type { OwnerNotes } from "./notes.js";

export interface KnowledgeToggles {
  digest: boolean;
  calendar: boolean;
  memory: boolean;
  notes: boolean;
}

export interface KnowledgeOpts {
  digests: DigestStore | null;
  calendar: EventCalendar | null;
  memory: TradeMemory | null;
  notes: OwnerNotes | null;
  enabled: () => KnowledgeToggles;
  /** Similar past trades needed before memory changes a size. */
  memoryMinSamples: number;
  /** A digest older than this is ignored by the verdict. */
  digestMaxAgeMs: number;
  now?: () => number;
}

/** Never shrink below this through knowledge alone (a veto is the tool for "do not trade"). */
export const MIN_KNOWLEDGE_MULT = 0.25;

export class KnowledgeLayer {
  constructor(private o: KnowledgeOpts) {}

  private now() {
    return (this.o.now ?? Date.now)();
  }

  private freshDigest(coin: string): Digest | null {
    const d = this.o.digests?.get(coin) ?? null;
    return d && this.now() - d.at <= this.o.digestMaxAgeMs ? d : null;
  }

  /** The entry picture for trade memory (also saved on the position at entry). */
  features(view: MarketView, instId: string): EntryFeatures {
    return featuresOf(view.stats.get(instId), this.freshDigest(coinOf(instId))?.sentiment ?? null);
  }

  verdict(style: string, view: MarketView, instId: string, side: Side): KnowledgeVerdict {
    const on = this.o.enabled();
    const coin = coinOf(instId);
    const notes: string[] = [];
    let mult = 1;
    const now = this.now();

    if (on.calendar && this.o.calendar) {
      const active = this.o.calendar.active(coin, now);
      const high = active.find((e) => e.impact === "high");
      if (high) return { veto: `event ${high.title} (${relTime(high.at - now)})`, sizeMult: 0, notes: [high.title] };
      const med = active.find((e) => e.impact === "medium");
      if (med) {
        mult *= 0.5;
        notes.push(`event ${med.title}`);
      }
    }

    if (on.digest) {
      const d = this.freshDigest(coin);
      if (d) {
        const severe = d.flags.filter((f) => SEVERE_FLAGS.includes(f));
        if (severe.length && side === "long") return { veto: `news ${severe.join("+")} on ${coin}`, sizeMult: 0, notes: severe };
        if (d.flags.length) {
          mult *= 0.5;
          notes.push(`news ${d.flags.join("+")}`);
        }
        const dir = side === "long" ? 1 : -1;
        if (d.confidence >= 0.5 && dir * d.sentiment <= -0.4) {
          mult *= 0.5;
          notes.push(`news against ${side} (${d.sentiment.toFixed(1)})`);
        }
      }
    }

    if (on.memory && this.o.memory) {
      const m = this.o.memory.similar(style, side, this.features(view, instId));
      if (m && m.n >= this.o.memoryMinSamples) {
        if (m.avgR < -0.5 && m.winRate < 0.3) {
          mult *= 0.25;
          notes.push(`memory ${m.avgR.toFixed(1)}R n=${m.n}`);
        } else if (m.avgR < -0.2) {
          mult *= 0.5;
          notes.push(`memory ${m.avgR.toFixed(1)}R n=${m.n}`);
        }
      }
    }

    return { veto: null, sizeMult: Math.max(MIN_KNOWLEDGE_MULT, mult), notes };
  }

  /** Context for the model: a few compact lines, empty when nothing is on or known. */
  context(style: string, coins: string[], side: Side | null): string {
    const on = this.o.enabled();
    const now = this.now();
    const lines: string[] = [];
    if (on.digest) {
      for (const coin of coins.slice(0, 6)) {
        const d = this.freshDigest(coin);
        if (!d || (d.items === 0 && !d.flags.length)) continue;
        lines.push(`news ${coin}: sentiment ${d.sentiment >= 0 ? "+" : ""}${d.sentiment.toFixed(2)} conf ${d.confidence.toFixed(1)}${d.flags.length ? ` flags ${d.flags.join(",")}` : ""}${d.events.length ? `; ${d.events.join("; ")}` : ""}`);
      }
    }
    if (on.calendar && this.o.calendar) {
      for (const e of this.o.calendar.upcoming(12, now).slice(0, 4)) lines.push(`event ${relTime(e.at - now)}: ${e.title} (${e.impact})`);
    }
    if (on.memory && this.o.memory && side) {
      // The first coin is the one the wasp holds or ranks first.
      const m = coins[0] ? this.o.memory.similar(style, side, { regime: null, regimeDir: null, adx: null, er: null, rsi14: null, ret24hPct: null, atr14Pct: null, fundingZ: null, volZ: null, newsSentiment: null }) : null;
      if (m && m.n >= 5) lines.push(`memory ${style} ${side}: ${m.n} recent trades, win ${(m.winRate * 100).toFixed(0)}%, avg ${m.avgR >= 0 ? "+" : ""}${m.avgR.toFixed(2)}R`);
    }
    if (on.notes && this.o.notes) {
      const t = this.o.notes.text();
      if (t) lines.push(`owner notes:\n${t}`);
    }
    return lines.join("\n");
  }

  recordClose(t: ClosedTrade): void {
    if (this.o.memory) this.o.memory.record(t);
  }
}

export function relTime(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60_000);
  const s = m >= 120 ? `${Math.round(m / 60)}h` : `${m}m`;
  return ms >= 0 ? `in ${s}` : `${s} ago`;
}
