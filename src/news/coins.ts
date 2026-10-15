// Which coins a headline is about. Conservative on purpose: a wrong tag can veto a trade, a missing tag only means the
// item counts as market-wide. Matches full names ("Bitcoin"), $TICKERS anywhere, and bare tickers of 3+ letters as
// whole upper-case words ("ETH", not "eth" inside "Ethernet").
import { createHash } from "node:crypto";

const NAMES: Record<string, string[]> = {
  BTC: ["bitcoin"],
  ETH: ["ethereum", "ether"],
  SOL: ["solana"],
  XRP: ["xrp", "ripple"],
  DOGE: ["dogecoin"],
  ADA: ["cardano"],
  AVAX: ["avalanche"],
  LINK: ["chainlink"],
  DOT: ["polkadot"],
  SUI: ["sui network"],
  HYPE: ["hyperliquid"],
  TON: ["toncoin", "the open network"],
  TRX: ["tron"],
  LTC: ["litecoin"],
  BCH: ["bitcoin cash"],
  BNB: ["binance coin", "bnb chain"],
  PEPE: ["pepe"],
  SHIB: ["shiba inu"],
  APT: ["aptos"],
  ARB: ["arbitrum"],
  OP: ["optimism"],
  NEAR: ["near protocol"],
  UNI: ["uniswap"],
  AAVE: ["aave"],
  TRUMP: ["$trump", "trump coin", "trump memecoin"],
};

/** Words that look like tickers but are ordinary English or finance terms. */
const NOT_TICKERS = new Set(["THE", "AND", "FOR", "NEW", "CEO", "ETF", "SEC", "USD", "API", "NFT", "DAO", "CPI", "FED", "GDP", "IPO", "USA", "ALL", "ONE", "NOW", "TOP", "BIG", "WAR", "AI"]);

/** Tag a text with the coins it mentions, among `known` (the tradable universe) plus the name dictionary. */
export function tagCoins(text: string, known: Iterable<string> = Object.keys(NAMES)): string[] {
  const found = new Set<string>();
  const lower = ` ${text.toLowerCase()} `;
  const knownSet = new Set([...known].map((c) => c.toUpperCase()));
  for (const [coin, names] of Object.entries(NAMES)) {
    if (!knownSet.has(coin) && knownSet.size) continue;
    for (const n of names) {
      const re = new RegExp(`(^|[^a-z0-9$])${escape(n)}($|[^a-z0-9])`);
      if (re.test(lower)) {
        found.add(coin);
        break;
      }
    }
  }
  // "Bitcoin Cash" must not also count as Bitcoin when that is the only mention.
  if (found.has("BCH") && !/\bbitcoin(?! cash)\b/i.test(text)) found.delete("BTC");
  for (const m of text.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/g)) {
    const t = m[1]!.toUpperCase();
    if (knownSet.has(t)) found.add(t);
  }
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{2,9})\b/g)) {
    const t = m[1]!;
    if (knownSet.has(t) && !NOT_TICKERS.has(t)) found.add(t);
  }
  return [...found].sort();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function newsId(url: string | null, source: string, title: string): string {
  const key = url ? canonicalUrl(url) : `${source}|${title.toLowerCase().trim()}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 20);
}

/** Drop tracking parameters and fragments so the same story from two feeds de-duplicates. */
export function canonicalUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|ref$|source$|fbclid$|gclid$)/i.test(k)) url.searchParams.delete(k);
    return `${url.host.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return u.trim();
  }
}

/** Plain text from HTML or CDATA, collapsed and capped. */
export function plainText(s: string | undefined, max = 300): string {
  if (!s) return "";
  // Feeds carry escaped HTML inside XML: two layers of entities. Decode the XML layer, strip tags, then decode the
  // HTML layer (&amp; last in each, so "&amp;lt;" stays text).
  const decode = (x: string) =>
    x
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&amp;/g, "&");
  const t = decode(decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).replace(/<[^>]+>/g, " "))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
