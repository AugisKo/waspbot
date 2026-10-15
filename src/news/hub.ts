// The news hub: runs each enabled source on its own schedule, de-duplicates what comes back, keeps 7 days of items in
// the engine DB, and answers "what is the news on BTC in the last N hours?". A source that throws never stops the others.
import type { Db } from "../db.js";
import { log } from "../log.js";
import { safeError } from "../redact.js";
import type { NewsItem, NewsProvider, NewsSourceId } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS news_items (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, publisher TEXT NOT NULL, title TEXT NOT NULL, url TEXT,
  published_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL, coins TEXT NOT NULL, summary TEXT, sentiment REAL
);
CREATE INDEX IF NOT EXISTS news_items_ts ON news_items(published_at);
`;

const KEEP_MS = 7 * 86_400_000;

export interface NewsHubOpts {
  db: Db;
  providers: NewsProvider[];
  /** Is this source switched on right now (dashboard controls)? */
  enabled: (id: NewsSourceId) => boolean;
  /** The coins worth asking about (held + watched). */
  coins: () => string[];
  now?: () => number;
}

export class NewsHub {
  private lastRun = new Map<NewsSourceId, number>();
  private running = false;
  private now: () => number;
  /** Bumped whenever new items arrive (the digest uses it to know what changed). */
  version = 0;
  lastError: Partial<Record<NewsSourceId, { at: number; message: string }>> = {};

  constructor(private o: NewsHubOpts) {
    this.now = o.now ?? Date.now;
    o.db.raw.exec(SCHEMA);
  }

  /** Run every source that is due. Returns how many new items were stored. */
  async poll(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let added = 0;
    try {
      const now = this.now();
      const coins = this.o.coins();
      await Promise.all(
        this.o.providers.map(async (p) => {
          if (!this.o.enabled(p.id)) return;
          if (now - (this.lastRun.get(p.id) ?? 0) < p.everyMs) return;
          this.lastRun.set(p.id, now);
          try {
            const items = await p.fetch(coins, now);
            added += this.store(items, now);
          } catch (err) {
            this.lastError[p.id] = { at: now, message: safeError(err).message };
            log.warn("news source failed", { source: p.id, err: safeError(err) });
          }
        }),
      );
      this.o.db.raw.prepare(`DELETE FROM news_items WHERE published_at < ?`).run(now - KEEP_MS);
      if (added) this.version++;
    } finally {
      this.running = false;
    }
    return added;
  }

  /** Insert new items (the first source to report a story keeps it). Returns how many were new. */
  store(items: NewsItem[], now = this.now()): number {
    const ins = this.o.db.raw.prepare(
      `INSERT OR IGNORE INTO news_items (id, source, publisher, title, url, published_at, fetched_at, coins, summary, sentiment) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    let n = 0;
    for (const i of items) {
      const r = ins.run(i.id, i.source, i.publisher, i.title, i.url, i.publishedAt, now, `,${i.coins.join(",")},`, i.summary ?? null, i.sentiment ?? null);
      n += Number(r.changes);
    }
    return n;
  }

  /** Items about `coin` (or market-wide ones when includeGeneral) from the last `hours`, newest first. */
  recent(coin: string | null, hours: number, limit = 30, includeGeneral = true): NewsItem[] {
    const since = this.now() - hours * 3_600_000;
    const rows = (
      coin
        ? this.o.db.raw
            .prepare(`SELECT * FROM news_items WHERE published_at >= ? AND (coins LIKE ? ${includeGeneral ? "OR coins = ',,'" : ""}) ORDER BY published_at DESC LIMIT ?`)
            .all(since, `%,${coin},%`, limit)
        : this.o.db.raw.prepare(`SELECT * FROM news_items WHERE published_at >= ? ORDER BY published_at DESC LIMIT ?`).all(since, limit)
    ) as Array<{ id: string; source: NewsSourceId; publisher: string; title: string; url: string | null; published_at: number; coins: string; summary: string | null; sentiment: number | null }>;
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      publisher: r.publisher,
      title: r.title,
      url: r.url,
      publishedAt: r.published_at,
      coins: r.coins.split(",").filter(Boolean),
      ...(r.summary ? { summary: r.summary } : {}),
      sentiment: r.sentiment,
    }));
  }

  /** Per-source counts in the last 24 h, for the dashboard. */
  stats(): Record<string, number> {
    const rows = this.o.db.raw.prepare(`SELECT source, COUNT(*) AS n FROM news_items WHERE published_at >= ? GROUP BY source`).all(this.now() - 86_400_000) as Array<{ source: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.source, Number(r.n)]));
  }
}
