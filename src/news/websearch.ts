// News found by a model searching the web itself (Claude's web search tool, Gemini's Google Search grounding or
// OpenAI's web search). The most flexible source and the most expensive one, so it runs rarely (NEWS_WEB_SEARCH_EVERY_MIN,
// default 60), only for the coins the wasps hold or watch, and inside the knowledge layer's daily budget.
import type { KnowledgeLlm } from "../llm/client.js";
import { newsId, plainText } from "./coins.js";
import type { NewsItem, NewsProvider } from "./types.js";

interface Found {
  title: string;
  url?: string | null;
  publisher?: string | null;
  published_at?: string | null;
  coins?: string[];
  sentiment?: number | null;
  summary?: string | null;
}

export function validateFound(v: unknown): Found[] | null {
  const items = Array.isArray(v) ? v : Array.isArray((v as { items?: unknown })?.items) ? (v as { items: unknown[] }).items : null;
  if (!items) return null;
  return items.filter((x): x is Found => !!x && typeof x === "object" && typeof (x as Found).title === "string").slice(0, 20);
}

export function webSearchPrompt(coins: string[], now: number): string {
  return [
    `Today is ${new Date(now).toISOString().slice(0, 16)}Z. Search the web for news from the last 24 hours that could move these crypto assets: ${coins.join(", ")}.`,
    "Include market-wide news (regulation, ETF flows, exchange incidents, hacks, macro events) when it matters for crypto.",
    "Only report items you actually found, with their real URL. Do not guess or invent anything. Prefer primary sources and major outlets.",
    'Return JSON: {"items":[{"title":"...","url":"https://...","publisher":"...","published_at":"ISO-8601","coins":["BTC"],"sentiment":-1..1,"summary":"one sentence"}]}, at most 10 items, newest first.',
  ].join("\n");
}

export function createWebSearchProvider(o: { llm: () => KnowledgeLlm | null; everyMs?: number; maxCoins?: number }): NewsProvider {
  return {
    id: "websearch",
    everyMs: o.everyMs ?? 60 * 60_000,
    async fetch(coins, now) {
      const llm = o.llm();
      if (!llm || !coins.length) return [];
      const ask = coins.slice(0, o.maxCoins ?? 6);
      const r = await llm.json({ prompt: webSearchPrompt(ask, now), maxOutputTokens: 1500, temperature: 0, webSearch: true, maxSearches: 3 }, validateFound);
      if (!r.ok) return [];
      const known = new Set(ask);
      return r.value.map((f) => {
        const ts = Date.parse(f.published_at ?? "");
        const url = f.url && /^https?:\/\//.test(f.url) ? f.url : null;
        return {
          id: newsId(url, "websearch", f.title),
          source: "websearch" as const,
          publisher: plainText(f.publisher ?? "web", 60) || "web",
          title: plainText(f.title, 300),
          url,
          publishedAt: Number.isFinite(ts) && ts <= now + 10 * 60_000 ? ts : now,
          coins: (f.coins ?? []).map((c) => String(c).toUpperCase()).filter((c) => known.has(c)),
          summary: plainText(f.summary ?? undefined, 300) || undefined,
          sentiment: typeof f.sentiment === "number" && Number.isFinite(f.sentiment) ? Math.max(-1, Math.min(1, f.sentiment)) : null,
        } satisfies NewsItem;
      });
    },
  };
}
