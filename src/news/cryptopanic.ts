// CryptoPanic: aggregated crypto news with community votes. Needs a (free) API token, CRYPTOPANIC_TOKEN. The API takes
// the token as a query parameter, so the request URL is never logged (only the HTTP status is). Tolerant parsing:
// the field names differ between API versions (currencies/instruments, url/original_url).
import { log } from "../log.js";
import { safeError } from "../redact.js";
import { newsId, plainText, tagCoins } from "./coins.js";
import type { NewsItem, NewsProvider } from "./types.js";

export const CRYPTOPANIC_DEFAULT_URL = "https://cryptopanic.com/api/developer/v2/posts/";

interface Post {
  id?: number | string;
  title?: string;
  published_at?: string;
  created_at?: string;
  url?: string;
  original_url?: string;
  domain?: string;
  source?: { title?: string; domain?: string };
  currencies?: Array<{ code?: string }>;
  instruments?: Array<{ code?: string }>;
  votes?: { positive?: number; negative?: number; liked?: number; disliked?: number; important?: number; toxic?: number };
  description?: string;
}

/** Community vote balance, -1..1, or null with too few votes to mean anything. */
export function voteSentiment(v: Post["votes"]): number | null {
  if (!v) return null;
  const pos = (v.positive ?? 0) + (v.liked ?? 0);
  const neg = (v.negative ?? 0) + (v.disliked ?? 0) + (v.toxic ?? 0);
  return pos + neg >= 3 ? (pos - neg) / (pos + neg) : null;
}

export function parsePosts(data: unknown, known: string[]): NewsItem[] {
  const results = ((data as { results?: Post[] })?.results ?? []) as Post[];
  const out: NewsItem[] = [];
  for (const p of results) {
    const title = plainText(p.title, 300);
    if (!title) continue;
    const ts = Date.parse(p.published_at ?? p.created_at ?? "");
    const url = p.original_url ?? p.url ?? null;
    const listed = [...(p.currencies ?? []), ...(p.instruments ?? [])].map((c) => (c.code ?? "").toUpperCase()).filter(Boolean);
    const coins = listed.length ? [...new Set(listed)].sort() : tagCoins(title, known);
    out.push({
      id: newsId(url, "cryptopanic", title),
      source: "cryptopanic",
      publisher: `CryptoPanic${p.source?.title ? `: ${p.source.title}` : p.domain ? `: ${p.domain}` : ""}`,
      title,
      url: url && /^https?:\/\//.test(url) ? url : null,
      publishedAt: Number.isFinite(ts) ? ts : Date.now(),
      coins,
      summary: plainText(p.description, 300) || undefined,
      sentiment: voteSentiment(p.votes),
    });
  }
  return out;
}

export function createCryptoPanicProvider(o: { token: string; url?: string; known: () => string[]; everyMs?: number; timeoutMs?: number; fetchFn?: typeof fetch }): NewsProvider {
  let offUntil = 0;
  return {
    id: "cryptopanic",
    // The free tier is rate limited; every 15 minutes is plenty for headlines.
    everyMs: o.everyMs ?? 15 * 60_000,
    async fetch(coins, now) {
      if (now < offUntil) return [];
      const u = new URL(o.url ?? CRYPTOPANIC_DEFAULT_URL);
      u.searchParams.set("auth_token", o.token);
      u.searchParams.set("public", "true");
      if (coins.length) u.searchParams.set("currencies", coins.slice(0, 50).join(","));
      try {
        const res = await (o.fetchFn ?? fetch)(u, { signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
        if (!res.ok) {
          offUntil = now + (res.status === 429 ? 60 : 30) * 60_000;
          log.warn("cryptopanic request failed", { status: res.status });
          return [];
        }
        return parsePosts(await res.json(), o.known());
      } catch (err) {
        offUntil = now + 30 * 60_000;
        // safeError only: the error could carry the URL, and the URL carries the token.
        log.warn("cryptopanic request failed", { err: { code: safeError(err).code } });
        return [];
      }
    },
  };
}
