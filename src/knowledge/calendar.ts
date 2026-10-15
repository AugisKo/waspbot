// Event calendar: known risk events (FOMC, CPI, payrolls, token unlocks, network upgrades, listings) around which a
// wasp should not open new positions, or should open smaller ones. Two sources, merged:
// - data/events.json, edited by the owner (see docs/KNOWLEDGE.md for the format);
// - an optional iCalendar feed (EVENTS_ICS_URL), e.g. an economic calendar export, re-read every 6 hours.
// The calendar never closes or opens anything: it vetoes or shrinks new risk inside each event's window.
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { log } from "../log.js";
import { safeError } from "../redact.js";

export type Impact = "high" | "medium" | "low";

export interface CalendarEvent {
  at: number;
  title: string;
  impact: Impact;
  /** Coins it applies to; ["*"] = all. */
  coins: string[];
  beforeMin: number;
  afterMin: number;
}

const FileEvent = z.object({
  at: z.string().refine((s) => Number.isFinite(Date.parse(s)), "must be an ISO date-time, e.g. 2026-11-04T18:00:00Z"),
  title: z.string().min(1).max(120),
  impact: z.enum(["high", "medium", "low"]).default("high"),
  coins: z.array(z.string().toUpperCase()).default(["*"]),
  beforeMin: z.number().min(0).max(24 * 60).optional(),
  afterMin: z.number().min(0).max(24 * 60).optional(),
});
const FileSchema = z.object({ events: z.array(FileEvent) });

export const WINDOWS: Record<Impact, { beforeMin: number; afterMin: number }> = {
  high: { beforeMin: 30, afterMin: 60 },
  medium: { beforeMin: 15, afterMin: 30 },
  low: { beforeMin: 0, afterMin: 0 },
};

/** Guess an event's impact from its title (for calendar feeds that do not say). */
export function impactOf(title: string): Impact {
  if (/\b(FOMC|fed(eral reserve)? (rate|interest|decision)|rate decision|CPI|consumer price|nonfarm|non-farm|payrolls|NFP|PCE|ECB rate)\b/i.test(title)) return "high";
  if (/\b(PPI|GDP|jobless claims|retail sales|ISM|unemployment|powell|minutes|token unlock|unlock|hard fork|mainnet|upgrade)\b/i.test(title)) return "medium";
  return "low";
}

/** Minimal iCalendar reader: VEVENT blocks with DTSTART and SUMMARY (unfolded lines, UTC or floating times). */
export function parseIcs(text: string): Array<{ at: number; title: string }> {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const out: Array<{ at: number; title: string }> = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0] ?? "";
    const start = /^DTSTART(?:;[^:\n]*)?:(\d{8}(?:T\d{4,6}Z?)?)/m.exec(body)?.[1];
    const summary = /^SUMMARY(?:;[^:\n]*)?:(.*)$/m.exec(body)?.[1]?.replace(/\\,/g, ",").replace(/\\n/g, " ").trim();
    if (!start || !summary) continue;
    const y = start.slice(0, 4), mo = start.slice(4, 6), d = start.slice(6, 8);
    const hh = start.slice(9, 11) || "00", mm = start.slice(11, 13) || "00", ss = start.slice(13, 15) || "00";
    // Floating times (no Z) are read as UTC: say so in docs, most economic-calendar exports are UTC.
    const at = Date.parse(`${y}-${mo}-${d}T${hh}:${mm}:${ss}Z`);
    if (Number.isFinite(at)) out.push({ at, title: summary.slice(0, 120) });
  }
  return out;
}

export function loadEventsFile(path: string): CalendarEvent[] {
  if (!existsSync(path)) return [];
  const parsed = FileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return parsed.data.events.map((e) => ({
    at: Date.parse(e.at),
    title: e.title,
    impact: e.impact,
    coins: e.coins.length ? e.coins : ["*"],
    beforeMin: e.beforeMin ?? WINDOWS[e.impact].beforeMin,
    afterMin: e.afterMin ?? WINDOWS[e.impact].afterMin,
  }));
}

export class EventCalendar {
  private fileEvents: CalendarEvent[] = [];
  private icsEvents: CalendarEvent[] = [];
  private fileMtime = 0;
  private icsAt = 0;

  constructor(
    private o: { path: string; icsUrl?: string; fetchFn?: typeof fetch; now?: () => number; statMtime?: (p: string) => number },
  ) {}

  private now() {
    return (this.o.now ?? Date.now)();
  }

  /** Re-read the file when it changed, and the feed every 6 hours. Never throws. */
  async refresh(): Promise<void> {
    try {
      const m = this.o.statMtime ? this.o.statMtime(this.o.path) : await import("node:fs").then((fs) => (fs.existsSync(this.o.path) ? fs.statSync(this.o.path).mtimeMs : 0));
      if (m !== this.fileMtime) {
        this.fileMtime = m;
        this.fileEvents = loadEventsFile(this.o.path);
        log.info("event calendar loaded", { events: this.fileEvents.length });
      }
    } catch (err) {
      log.warn("events file is not valid, keeping the previous events", { err: safeError(err) });
    }
    if (this.o.icsUrl && this.now() - this.icsAt > 6 * 3_600_000) {
      this.icsAt = this.now();
      try {
        const res = await (this.o.fetchFn ?? fetch)(this.o.icsUrl, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.icsEvents = parseIcs((await res.text()).slice(0, 2_000_000))
          .map((e) => ({ ...e, impact: impactOf(e.title) }))
          .filter((e) => e.impact !== "low")
          .map((e) => ({ ...e, coins: ["*"], ...WINDOWS[e.impact] }));
      } catch (err) {
        log.warn("event calendar feed failed", { err: { code: safeError(err).code } });
      }
    }
  }

  /** Replace the events (tests, backtests). */
  set(events: CalendarEvent[]): void {
    this.fileEvents = events;
    this.icsEvents = [];
    this.fileMtime = -1;
  }

  all(): CalendarEvent[] {
    return [...this.fileEvents, ...this.icsEvents].sort((a, b) => a.at - b.at);
  }

  /** Events whose window covers `now` for this coin. */
  active(coin: string, now = this.now()): CalendarEvent[] {
    return this.all().filter((e) => (e.coins.includes("*") || e.coins.includes(coin)) && now >= e.at - e.beforeMin * 60_000 && now <= e.at + e.afterMin * 60_000);
  }

  /** The next events within `hours`, for the model's context and the dashboard. */
  upcoming(hours: number, now = this.now()): CalendarEvent[] {
    return this.all().filter((e) => e.at >= now && e.at <= now + hours * 3_600_000);
  }
}
