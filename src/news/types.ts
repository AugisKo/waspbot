// News for the knowledge layer: headlines from several sources, each one switchable on its own, tagged with the coins
// they are about, de-duplicated and kept in the engine DB for 7 days.

export type NewsSourceId = "rss" | "cryptopanic" | "websearch" | "okx";

export interface NewsItem {
  /** Stable id: a hash of the canonical URL (or of source + title when there is no URL). */
  id: string;
  source: NewsSourceId;
  /** Publisher or feed name ("CoinDesk", "CryptoPanic: Cointelegraph"). */
  publisher: string;
  title: string;
  url: string | null;
  publishedAt: number;
  /** Tickers the item is about (BTC, ETH, ...). Empty = market-wide. */
  coins: string[];
  /** Optional short text (feed description, model summary), plain text, at most ~300 chars. */
  summary?: string;
  /** Source-provided sentiment, -1..1, when there is one (CryptoPanic votes, a model's read). */
  sentiment?: number | null;
}

export interface NewsProvider {
  id: NewsSourceId;
  /** Minimum time between fetches. */
  everyMs: number;
  /** Fetch recent items for these coins (some sources ignore the list and return market-wide news). */
  fetch(coins: string[], now: number): Promise<NewsItem[]>;
}
