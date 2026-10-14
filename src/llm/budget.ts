// A hard daily USD budget for the knowledge layer's model calls (news digests, web search), separate from the
// chooser's cap. A call reserves its worst case before it is sent and settles to what it was charged; today's total
// survives a restart (engine DB meta).
import type { Db } from "../db.js";

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class DailyBudget {
  private day: string;
  private spent: number;
  private reserved = 0;

  constructor(
    private name: string,
    private capUsd: () => number,
    private db: Pick<Db, "getMeta" | "setMeta"> | null,
    private now: () => number = Date.now,
  ) {
    this.day = dayKey(this.now());
    this.spent = Number(this.db?.getMeta(this.key()) ?? 0) || 0;
  }

  private key() {
    return `budget:${this.name}:${this.day}`;
  }

  private roll() {
    const d = dayKey(this.now());
    if (d !== this.day) {
      this.day = d;
      this.spent = Number(this.db?.getMeta(this.key()) ?? 0) || 0;
    }
  }

  get spentTodayUsd(): number {
    this.roll();
    return this.spent;
  }

  get cap(): number {
    return this.capUsd();
  }

  /** Reserve a worst case. false = it does not fit today; do not make the call. */
  reserve(worstUsd: number): boolean {
    this.roll();
    if (!(worstUsd >= 0) || this.spent + this.reserved + worstUsd > this.capUsd()) return false;
    this.reserved += worstUsd;
    return true;
  }

  settle(worstUsd: number, chargedUsd: number): void {
    this.roll();
    this.reserved = Math.max(0, this.reserved - worstUsd);
    this.spent += Math.max(0, chargedUsd);
    this.db?.setMeta(this.key(), String(this.spent));
  }
}
