import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { canonicalUrl, newsId, plainText, tagCoins } from "../src/news/coins.js";
import { parsePosts, voteSentiment } from "../src/news/cryptopanic.js";
import { NewsHub } from "../src/news/hub.js";
import { createRssProvider, parseFeed } from "../src/news/rss.js";
import type { NewsItem, NewsProvider } from "../src/news/types.js";
import { validateFound } from "../src/news/websearch.js";

const NOW = Date.UTC(2026, 9, 14, 12);

const RSS = `<?xml version="1.0"?><rss><channel><title>Feed</title>
<item><title><![CDATA[Bitcoin ETF inflows hit $400M as BTC rallies]]></title><link>https://www.example.com/a?utm_source=x</link><pubDate>Wed, 14 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Spot ETFs saw &amp;amp; more&lt;/p&gt;</description></item>
<item><title>Solana network halted for 3 hours</title><link>https://example.com/b</link><pubDate>Wed, 14 Oct 2026 11:00:00 GMT</pubDate></item>
<item><title>Old news</title><link>https://example.com/old</link><pubDate>Mon, 05 Oct 2026 11:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<feed><entry><title>Ethereum upgrade goes live</title><link href="https://ex.org/eth"/><updated>2026-10-14T09:00:00Z</updated><summary>ETH devs ship it</summary></entry></feed>`;

describe("coin tagging", () => {
  it("finds names, $tickers and upper-case tickers, not English words", () => {
    expect(tagCoins("Bitcoin and Ethereum slide while $SOL jumps", ["BTC", "ETH", "SOL"])).toEqual(["BTC", "ETH", "SOL"]);
    expect(tagCoins("The SEC and the CEO met; ETF talk", ["BTC", "ETH"])).toEqual([]);
    expect(tagCoins("DOGE pumps", ["DOGE"])).toEqual(["DOGE"]);
    expect(tagCoins("Bitcoin Cash forks", ["BTC", "BCH"])).toEqual(["BCH"]);
    expect(tagCoins("ethernet cables", ["ETH"])).toEqual([]);
  });

  it("de-duplicates the same story across feeds", () => {
    expect(canonicalUrl("https://www.example.com/a/?utm_source=x#top")).toBe("example.com/a");
    expect(newsId("https://example.com/a?utm_medium=y", "rss", "x")).toBe(newsId("https://www.example.com/a/", "cryptopanic", "other title"));
    expect(plainText("<p>A &amp; B</p>")).toBe("A & B");
  });
});

describe("rss", () => {
  it("parses RSS and Atom", () => {
    const r = parseFeed(RSS);
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ title: "Bitcoin ETF inflows hit $400M as BTC rallies", url: "https://www.example.com/a?utm_source=x" });
    expect(r[0]!.summary).toBe("Spot ETFs saw & more");
    expect(parseFeed(ATOM)[0]).toMatchObject({ title: "Ethereum upgrade goes live", url: "https://ex.org/eth" });
  });

  it("drops items older than 48 h, tags coins, and skips a failing feed for a while", async () => {
    let calls = 0;
    const fetchFn = (async (url: string) => {
      calls++;
      if (String(url).includes("bad")) return new Response("nope", { status: 500 });
      return new Response(RSS);
    }) as unknown as typeof fetch;
    const p = createRssProvider({ feeds: ["https://good.example/rss", "https://bad.example/rss"], known: () => ["BTC", "SOL"], fetchFn });
    const items = await p.fetch([], NOW);
    expect(items.map((i) => i.title)).toEqual(["Bitcoin ETF inflows hit $400M as BTC rallies", "Solana network halted for 3 hours"]);
    expect(items[0]!.coins).toEqual(["BTC"]);
    expect(items[1]!.coins).toEqual(["SOL"]);
    await p.fetch([], NOW + 60_000);
    expect(calls).toBe(3); // the bad feed is not asked again inside 30 min
  });
});

describe("cryptopanic", () => {
  it("parses posts with either field naming, and votes into sentiment", () => {
    const items = parsePosts(
      {
        results: [
          { title: "BTC breaks out", published_at: "2026-10-14T10:00:00Z", url: "https://cp.example/1", currencies: [{ code: "BTC" }], votes: { positive: 8, negative: 2 }, source: { title: "CoinDesk" } },
          { title: "Some SOL news", created_at: "2026-10-14T11:00:00Z", original_url: "https://x.example/2", instruments: [{ code: "sol" }] },
        ],
      },
      ["BTC", "SOL"],
    );
    expect(items[0]).toMatchObject({ coins: ["BTC"], publisher: "CryptoPanic: CoinDesk", sentiment: 0.6 });
    expect(items[1]).toMatchObject({ coins: ["SOL"], url: "https://x.example/2", sentiment: null });
    expect(voteSentiment({ positive: 1 })).toBeNull();
  });
});

describe("web search results", () => {
  it("accepts {items:[...]} or a bare array, and drops junk", () => {
    expect(validateFound({ items: [{ title: "a" }, { nope: 1 }, "x"] })).toEqual([{ title: "a" }]);
    expect(validateFound([{ title: "b" }])).toEqual([{ title: "b" }]);
    expect(validateFound({ foo: 1 })).toBeNull();
  });
});

describe("news hub", () => {
  const item = (over: Partial<NewsItem>): NewsItem => ({ id: "x", source: "rss", publisher: "P", title: "t", url: null, publishedAt: NOW - 3_600_000, coins: [], ...over });

  it("runs enabled sources on schedule, de-duplicates, and answers per coin", async () => {
    const db = new Db(":memory:");
    let now = NOW;
    let rssCalls = 0;
    const rss: NewsProvider = { id: "rss", everyMs: 600_000, fetch: async () => (rssCalls++, [item({ id: "a", coins: ["BTC"] }), item({ id: "b", title: "macro", coins: [] })]) };
    const cp: NewsProvider = { id: "cryptopanic", everyMs: 600_000, fetch: async () => [item({ id: "a", source: "cryptopanic" }), item({ id: "c", source: "cryptopanic", coins: ["ETH"] })] };
    const broken: NewsProvider = { id: "websearch", everyMs: 0, fetch: async () => { throw new Error("boom"); } };
    const enabled = { rss: true, cryptopanic: true, websearch: true, okx: false };
    const hub = new NewsHub({ db, providers: [rss, cp, broken], enabled: (id) => enabled[id], coins: () => ["BTC"], now: () => now });
    expect(await hub.poll()).toBe(3);
    expect(hub.recent("BTC", 24).map((i) => i.id).sort()).toEqual(["a", "b"]);
    expect(hub.recent("BTC", 24, 30, false).map((i) => i.id)).toEqual(["a"]);
    expect(hub.lastError.websearch?.message).toBe("boom");
    now += 60_000;
    await hub.poll();
    expect(rssCalls).toBe(1);
    enabled.rss = false;
    now += 700_000;
    await hub.poll();
    expect(rssCalls).toBe(1);
    expect(hub.stats()).toEqual({ rss: 2, cryptopanic: 1 });
  });
});
