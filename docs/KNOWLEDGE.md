# News and the knowledge layer

The knowledge layer gives the wasps context they cannot get from price data: what the news says, which events are
coming, and how similar trades went before. It has one hard rule:

> **It can veto or shrink an opening trade. It can never open one, close one, or move a stop.**

It is applied in the risk layer after every other gate, so it can only make a wasp more careful. A model reading the
news is a noisy, slow signal; treating it as a brake rather than an accelerator keeps that noise cheap.

Everything here can be switched on and off from **Controls** on the dashboard (owner password), and each part has a
setting in [`.env.example`](../.env.example).

## News sources

| Source | Setting | Needs | Notes |
|---|---|---|---|
| RSS | `NEWS_RSS`, `NEWS_RSS_FEEDS` | nothing | CoinDesk, Cointelegraph, Decrypt and The Block by default; any RSS or Atom feed works. Every 10 minutes. A feed that fails is skipped for 30 minutes. |
| CryptoPanic | `NEWS_CRYPTOPANIC`, `CRYPTOPANIC_TOKEN` | a free API token from cryptopanic.com | Aggregated news with community votes, which become a sentiment. Every 15 minutes. The token travels in the URL (their API design), so request URLs are never logged. |
| Model web search | `NEWS_WEB_SEARCH`, `NEWS_WEB_SEARCH_EVERY_MIN` | a model key | The knowledge model searches the web itself (Claude's web search tool, Gemini's Google Search, OpenAI's web search) for the coins the wasps hold or watch. Hourly by default; uses the knowledge budget. It is told to report only what it found, with real URLs. |
| OKX sentiment | `NEWS_OKX` | demo or live keys | OKX's own bullish/bearish ratio and mention counts (from beebots). Feeds the Momentum style's attention signal. |

Items are tagged with the coins they mention (full names, `$TICKERS`, and upper-case tickers of 3+ letters, never
English words like "THE" or "SEC"), de-duplicated across sources by their canonical URL, and kept for 7 days.

## News digest

Per coin, every minute: what the last 24 hours of headlines add up to.

- **Keywords** (always, free): sentiment from a short word list weighted by recency, plus source sentiment where there
  is one; risk flags from fixed patterns.
- **A model** (`KNOWLEDGE_LLM_PROVIDER`, with a key): reads up to 25 headlines and returns sentiment, confidence, flags
  and up to 3 short event notes. At most every `DIGEST_EVERY_MIN` per coin, only when there is news it has not seen,
  inside `KNOWLEDGE_DAILY_USD_CAP`. The keyword flags are always kept: a pattern match on "exploit" is not argued away.

Risk flags: `hack`, `exploit`, `delisting`, `insolvency`, `depeg`, `network_halt` (severe), and `regulatory_action`,
`lawsuit`, `outage`, `token_unlock`.

What the digest does to a trade:

| Situation | Effect |
|---|---|
| A severe flag on the coin, opening a long | **veto** |
| Any flag on the coin | size × 0.5 |
| Sentiment against the trade (≤ −0.4 in its direction) with confidence ≥ 0.5 | size × 0.5 |
| A digest older than 6 hours | ignored |

## Event calendar

`data/events.json` (created from [`events.example.json`](events.example.json) on first start; the example dates are in
the past, so it does nothing until you edit it):

```json
{
  "events": [
    { "at": "2026-11-04T18:00:00Z", "title": "FOMC rate decision", "impact": "high" },
    { "at": "2026-11-12T13:30:00Z", "title": "US CPI", "impact": "high" },
    { "at": "2026-11-15T00:00:00Z", "title": "SUI token unlock", "impact": "medium", "coins": ["SUI"] },
    { "at": "2026-11-20T12:00:00Z", "title": "Custom window", "impact": "high", "beforeMin": 60, "afterMin": 120 }
  ]
}
```

- `impact: high` vetoes new trades from 30 minutes before to 60 minutes after (or `beforeMin` / `afterMin`).
- `impact: medium` halves new trades from 15 minutes before to 30 minutes after.
- `coins` limits an event to some coins; the default `["*"]` means all of them.
- The file is re-read when it changes. A broken file keeps the previous events and logs why.
- `EVENTS_ICS_URL` adds an iCalendar feed (an economic-calendar export, say), re-read every 6 hours. Impact is guessed
  from the title (FOMC, CPI, payrolls, PCE are high; PPI, GDP, jobless claims, unlocks, upgrades are medium; anything
  else is ignored). Times without a time zone are read as UTC.

Use real dates from an official source (the Federal Reserve's FOMC calendar, the BLS release schedule). Nothing in
WaspBot knows them for you.

## Trade memory

Every closed trade is stored with the picture at entry (regime, ADX, efficiency ratio, RSI, 24-hour return, ATR,
funding z-score, volume z-score, news sentiment) and how it ended, in R: its net P&L after fees, divided by the risk it
took at entry.

Before a new open, the 20 most similar past trades of the same style and side are found (scaled distance over those
numbers, with a penalty for a different regime). Then:

| Similar trades (at least `MEMORY_MIN_SAMPLES`, default 15) | Effect |
|---|---|
| average below −0.2R | size × 0.5 |
| average below −0.5R and win rate below 30% | size × 0.25 |

Memory never vetoes: it has not seen enough of the market to be sure of anything. The model also sees a one-line
summary of recent trades of the style.

## Owner notes

Put `.md` or `.txt` files in `data/notes` (`NOTES_DIR`). They are read with every model decision, after the wasp's
strategy, capped at `NOTES_MAX_CHARS` (4000). Good for rules of thumb ("no new longs into the weekend") and things you
learned. The rules engine does not read them.

## Combining it all

The size multipliers multiply, with a floor of 0.25: knowledge alone never shrinks a trade to nothing (a veto is the
tool for "do not trade"). The model's context is a few lines: digests for the coins in its snapshot, events in the next
12 hours, the memory summary, and the notes.

## Cost

Keywords, the calendar and memory are free. With a model key, digests and web search share `KNOWLEDGE_DAILY_USD_CAP`
(default $1/day), which is a hard cap: every call reserves its worst case first and is not sent if it does not fit.
The dashboard's Controls panel shows today's spend.

## In backtests

Historical news is not available, so the digest is off in backtests. The calendar can be applied (`--events`) and the
memory gate compared (`--compare memory`). See [BACKTEST.md](BACKTEST.md).
