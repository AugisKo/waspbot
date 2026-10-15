// Free crypto news from public RSS/Atom feeds. No key, no cost. The feed list is NEWS_RSS_FEEDS (comma-separated);
// a feed that fails is skipped for 30 minutes, the others carry on.
import { log } from "../log.js";
import { safeError } from "../redact.js";
import { newsId, plainText, tagCoins } from "./coins.js";
import type { NewsItem, NewsProvider } from "./types.js";

export const DEFAULT_RSS_FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://decrypt.co/feed",
  "https://www.theblock.co/rss.xml",
];

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 48 * 3_600_000;

const tag = (block: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m?.[1];
};
const attr = (block: string, name: string, a: string): string | undefined => new RegExp(`<${name}[^>]*\\s${a}="([^"]+)"`, "i").exec(block)?.[1];

/** Parse an RSS 2.0 or Atom document into raw items. Tolerant: anything unreadable is skipped. */
export function parseFeed(xml: string): Array<{ title: string; url: string | null; publishedAt: number | null; summary: string }> {
  const out: Array<{ title: string; url: string | null; publishedAt: number | null; summary: string }> = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const b of blocks) {
    const title = plainText(tag(b, "title"), 300);
    if (!title) continue;
    const link = plainText(tag(b, "link"), 1000) || attr(b, "link", "href") || plainText(tag(b, "guid"), 1000) || null;
    const date = tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date");
    const ts = date ? Date.parse(plainText(date, 100)) : NaN;
    out.push({ title, url: link && /^https?:\/\//.test(link) ? link : null, publishedAt: Number.isFinite(ts) ? ts : null, summary: plainText(tag(b, "description") ?? tag(b, "summary"), 300) });
  }
  return out;
}

export function publisherOf(feedUrl: string): string {
  try {
    const h = new URL(feedUrl).hostname.replace(/^www\./, "");
    const known: Record<string, string> = { "coindesk.com": "CoinDesk", "cointelegraph.com": "Cointelegraph", "decrypt.co": "Decrypt", "theblock.co": "The Block" };
    return known[h] ?? h;
  } catch {
    return "RSS";
  }
}

export function createRssProvider(o: { feeds: string[]; known: () => string[]; everyMs?: number; timeoutMs?: number; fetchFn?: typeof fetch }): NewsProvider {
  const offUntil = new Map<string, number>();
  return {
    id: "rss",
    everyMs: o.everyMs ?? 10 * 60_000,
    async fetch(_coins, now) {
      const known = o.known();
      const items: NewsItem[] = [];
      await Promise.all(
        o.feeds.map(async (feed) => {
          if ((offUntil.get(feed) ?? 0) > now) return;
          try {
            const res = await (o.fetchFn ?? fetch)(feed, { headers: { accept: "application/rss+xml, application/atom+xml, text/xml;q=0.9, */*;q=0.5", "user-agent": "waspbot-news/1.0" }, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = (await res.text()).slice(0, MAX_BYTES);
            const publisher = publisherOf(feed);
            for (const r of parseFeed(text)) {
              const publishedAt = r.publishedAt ?? now;
              if (now - publishedAt > MAX_AGE_MS || publishedAt > now + 10 * 60_000) continue;
              items.push({ id: newsId(r.url, "rss", r.title), source: "rss", publisher, title: r.title, url: r.url, publishedAt, coins: tagCoins(`${r.title} ${r.summary}`, known), summary: r.summary || undefined });
            }
          } catch (err) {
            offUntil.set(feed, now + 30 * 60_000);
            log.warn("rss feed failed, skipped for 30 min", { feed: publisherOf(feed), err: safeError(err) });
          }
        }),
      );
      return items;
    },
  };
}
