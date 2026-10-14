# WaspBot

Three trading wasps on OKX perpetual futures. A **rules engine** or a **model** (Gemini, Claude, OpenAI or Jev) picks
each move, a **risk layer written in plain code** decides whether it happens, and a **news and knowledge layer** can make
the wasps more careful but never braver. A **backtester** replays the same engine over history, so you can measure it
before you trust it.

**It runs on paper by default.** The wasps use real market prices and simulated money. Nothing touches an exchange
account unless you change the settings yourself, on purpose.

> **Not financial advice.** WaspBot is an experiment and a piece of open-source software, not a trading product.
> Nothing it does is a recommendation to buy or sell anything. Leveraged crypto trading can lose everything you put
> in. The software comes with no warranty (see [LICENSE](LICENSE)). If you ever switch it to real money, that is your
> decision and your risk.

WaspBot is a fork of [beebots](https://github.com/imikerussell/beebots) by Mike Russell (MIT). The engine, the risk
layer, the three trading styles and the dashboard come from there; see [what changed](#what-changed-from-beebots).

## What changed from beebots

| | beebots | WaspBot |
|---|---|---|
| Who decides | Gemini 4 Argon or Jev, code as a fallback | **Rules engine or a model, switchable at runtime** from the dashboard. Models: Gemini, **Claude**, **OpenAI**, Jev |
| Proof it works | none | **Backtester**: the real engine replayed over OKX history, after fees, slippage and funding, against buy-and-hold, with an in-sample / out-of-sample split |
| "Never flat for long" | retired in config, code still there | **removed**: nothing is ever forced open |
| Market regime | – | **Regime filter** (ADX, efficiency ratio, volatility rank): Trend and Momentum only open with a trend their way, Breakout stays out of chop |
| Portfolio risk | per bee only | **Portfolio breaker** (drawdown from peak, daily loss), **net exposure cap**, **max wasps per coin**, **flatten on stale data** |
| News | OKX sentiment (demo/live only) | **RSS**, **CryptoPanic**, **model web search**, OKX sentiment, each switchable |
| Knowledge | – | **News digest** per coin, **event calendar**, **trade memory**, **owner notes**. It can veto or shrink a trade, never open one |
| Setup security | first visitor wins | **one-time setup code** from the server log |
| Leaderboard | beebots.tech Hive | none by default (`HIVE_URL` to point at one) |

## Run your own

Any machine with Docker works (a small VPS is plenty):

```sh
curl -fsSLO https://raw.githubusercontent.com/AugisKo/waspbot/main/docker-compose.yml
docker compose up -d
docker compose logs engine | grep "setup code"
```

Open `http://<your-server-ip>/` and go through Setup:

1. **Setup code**: the one printed in the log. Whoever reaches a fresh server first cannot take it without the log.
2. **Risk statements** and an **owner password** (8+ characters). The dashboard is public; the password is what lets
   you change things from it.
3. **Who decides**: the rules engine (no key, nothing spent) or a model: Claude, Gemini or Jev (paste its key).
   You can switch later from **Controls**.
4. **OpenAI key** (required): it designs each wasp from a sentence and paints its portrait.
5. **Your wasps**: for each one, say how it should trade ("a patient wasp that only trades BTC and ETH trends").
6. **Start paper trading.**

Use a domain with HTTPS if you can (`PUBLIC_DOMAIN`), so your keys never travel over plain HTTP. Setup stays open for
2 hours after the engine starts (`SETUP_WINDOW_MIN`); 20 wrong codes lock it until a restart.

The images (`ghcr.io/augisko/waspbot-*`) are built by the GitHub Actions workflow in this repo on every push to
`main` and on `v*` tags. Until that has run once (and the packages are public), build them yourself:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## How a decision is made

Every tick, for every wasp:

1. **Look.** OKX market data: tickers, candles, RSI, MACD, ATR, Bollinger, Donchian, funding, open interest, and the
   market regime per coin.
2. **Summarise.** A small numeric snapshot of the market and the wasp's own position.
3. **Choose.** The rules engine, or the model, picks one move from a menu of moves that are valid right now. The model
   also gets a few lines of context: the news digest, upcoming events, how similar past trades went, your notes.
4. **Check.** Plain code can veto, shrink or force the move (below). The knowledge layer comes last and can only veto
   or shrink.
5. **Record, then act.** The decision, who made it and why anything was vetoed is written to SQLite first.
6. **Broadcast.** The dashboard streams it live.

Stops never wait for the chooser: an exit watch checks every open position every couple of seconds.

## The decision engine

| | Rules engine | Model |
|---|---|---|
| Who picks | deterministic code (fixed priorities over the menu) | Gemini, Claude, OpenAI or Jev |
| Cost | nothing | per call, under a hard daily cap (`*_DAILY_USD_CAP`) |
| Reads your free-text rules and notes | no (coin limits still apply) | yes |
| Backtestable honestly | yes | partly: a model may have read about the period it trades |
| When it fails | – | the rules engine stands in, and the dashboard says so |

Switch it in **Controls** on the dashboard (owner password) or with `DECISION_ENGINE` and `LLM_PROVIDER`. Whatever
decides, the risk layer is the same. Start on the rules engine, backtest it, then compare a model against it
(`pnpm backtest -- --compare engine --max-llm-usd 5`) before paying for one.

## The risk layer

Per wasp (from beebots): max 2x leverage, a size ceiling, ATR stops that only ratchet in the wasp's favour, a profit
lock, time stops, cooldowns, a trade cap and a fee budget per day, a daily loss stop (8%), retirement below 40% of the
start, a spread gate and a funding veto.

Across the portfolio (new):

- **Breaker.** Total equity 20% below its peak closes everything and holds until you press **Resume** in Controls.
  6% down on the day closes everything until 00:00 UTC.
- **Net exposure cap.** The wasps' net notional stays within 1x total equity. Three wasps long BTC are one big bet.
- **Crowding.** At most 2 wasps in the same coin on the same side.
- **Stale data.** Market data older than 10 minutes closes open positions: a wasp does not hold what it cannot see.
- **Regime filter.** Trend and Momentum only open with a trend in their direction; Breakout stays out of directionless,
  high-volatility chop.

Every number is a setting (see [`.env.example`](.env.example)) and the full list is in
[`strategies/RISK_RULES.md`](strategies/RISK_RULES.md).

## News and knowledge

| Source | Needs | Default |
|---|---|---|
| RSS (CoinDesk, Cointelegraph, Decrypt, The Block) | nothing | on |
| CryptoPanic | a free token (`CRYPTOPANIC_TOKEN`) | on when a token is set |
| Model web search | a model key; uses the knowledge budget | off |
| OKX sentiment | demo or live keys | on |

The knowledge layer turns that into:

- **News digest** per coin: sentiment, confidence and risk flags (hack, exploit, delisting, depeg, ...). From keywords
  (free) and, with a model key, from a model within a $1/day budget. A severe flag keeps longs out of the coin; news
  strongly against a trade halves it.
- **Event calendar**: no new trades in the window around high-impact events (FOMC, CPI, ...), half size around medium
  ones. Edit `data/events.json` or point `EVENTS_ICS_URL` at a calendar feed.
- **Trade memory**: every closed trade is stored with its entry picture. When 15+ similar past trades lost on average,
  the next one is opened smaller.
- **Owner notes**: `.md`/`.txt` files in `data/notes` that the model reads with every decision.

It can only veto or shrink: nothing in it opens a position. Details: [docs/KNOWLEDGE.md](docs/KNOWLEDGE.md).

## Backtesting

```sh
pnpm install
pnpm backtest:fetch -- --coins BTC,ETH,SOL --days 120 --swap   # OKX public history, no key
pnpm backtest -- --coins BTC,ETH,SOL --split 0.7 --compare regime
```

It replays **the real engine** (same styles, chooser, risk layer and ledger) over 15-minute bars on a simulated clock.
Fills are taker fills at the bid or ask plus slippage, fees are charged, funding is paid every 8 hours, and every bar
the engine sees has already closed. The report shows return, CAGR, Sharpe, Sortino, max drawdown, trades, win rate,
average R, profit factor, fees, funding and time in the market, per wasp and together, against buy-and-hold BTC.

`pnpm backtest -- --synthetic` runs on generated data to check the pipeline without downloading anything. Results on
it mean nothing about markets. Read [docs/BACKTEST.md](docs/BACKTEST.md) before trusting any number.

## Settings

Most people need none: Setup covers the keys. Everything else goes in a `.env` next to `docker-compose.yml`; every
setting is documented in [`.env.example`](.env.example). The common ones:

| setting | default | what it does |
|---|---|---|
| `PUBLIC_DOMAIN` | blank | A domain pointed at your server: Caddy gets an HTTPS certificate on its own. Recommended. |
| `DECISION_ENGINE` | blank (`llm`) | `rules` or `llm`. Switchable from Controls. |
| `LLM_PROVIDER` | `auto` | `gemini`, `claude`, `openai` or `jev`; auto = first key found (gemini, claude, jev). |
| `ANTHROPIC_API_KEY` | blank | Claude as the chooser and/or the knowledge model. Set `ANTHROPIC_USD_PER_MTOK(_OUT)` to your model's price. |
| `CRYPTOPANIC_TOKEN` | blank | Turns on CryptoPanic news. |
| `KNOWLEDGE_DAILY_USD_CAP` | `1` | Hard budget for news digests and web search. |
| `PORTFOLIO_MAX_DRAWDOWN_PCT` | `20` | Portfolio breaker from the peak (owner resumes). |
| `NET_EXPOSURE_MAX_X` | `1` | Max net notional across wasps, × total equity. |
| `REGIME_FILTER` | `true` | Keep styles out of the wrong market regime. |
| `BEE_START_EQUITY_USD` | `333` | Paper money per wasp. |

**Run Setup again** (new names, keys, or a forgotten owner password):

```sh
docker compose exec engine rm /data/settings.json
docker compose restart engine
```

**Logs:** `docker compose logs engine`. **Backups:** a sidecar writes a nightly copy of each database to
`/data/backups` (7 days). That copy is on the same server: keep an off-server copy if you care about the history.

## The three trading styles

| style | built-in wasp | what it does |
|---|---|---|
| **Breakout** | Jacket, the striker | Both ways on 8 liquid majors: fades stretched moves, and takes confirmed daily breakouts on BTC, ETH, SOL or HYPE. 4-hour time stop. |
| **Trend** | Vespa, the patient one | Trend following on BTC and ETH only. Sits in cash in chop, adds only to a winner, sized under a volatility cap. |
| **Momentum** | Hornet, the chaser | Chases fresh, high-volume moves long or short, adds once to a winner, bails when the move stalls. |

Your Setup wasps run on one of these, restricted to the coins you name. The full rules are in
[`strategies/`](strategies/) (the internal ids `bizzy`, `breezy`, `boozy` and the `BEE1..3` variable names are kept
from beebots so its settings and databases keep working).

## The Beekeeper (optional)

An outside coach on Zapier that may rewrite a losing wasp's rules text and coin list, never its leverage, stops or
caps, with an Undo on the dashboard. It is unchanged from beebots: see [docs/BEEKEEPER.md](docs/BEEKEEPER.md).

## Real money (read this twice)

WaspBot can trade OKX demo accounts or real money, but only if you set it up by hand. There is no button for it.

- Real money needs **all** of: `DRY_RUN=false`, `MODE=live`, three OKX **EEA** sub-account API keys (`BEE1_OKX_API_KEY`
  etc., Read + Trade only, **never Withdraw or Transfer**, IP-bound to your server), and
  `LIVE_ACK=I-ACCEPT-REAL-MONEY-RISK`. With any one missing, the engine refuses to start. It also needs either a model
  key or `DECISION_ENGINE=rules` chosen on purpose.
- The first hours of live trading run at reduced size (`LIVE_SIZE_MULTIPLIER`, `LIVE_RAMP_HOURS`).
- The bot can never withdraw. Moving money off the exchange is always done by you.
- Try `MODE=demo` first, with OKX **demo** keys (`BEE1_OKX_DEMO_API_KEY` etc.).
- The engine talks to OKX's EEA site (`eea.okx.com`). Check that OKX derivatives are available where you live, and how
  they are taxed, before you go anywhere near real money.
- A good backtest is not a forecast. Paper-trade for weeks, and compare paper results with the backtest of the same
  period, before risking anything.

**Ending a live run:** `docker compose exec engine touch /data/close-live`. The engine stops deciding, closes every
position with reduce-only market orders, and keeps the dashboard up with the final result.

## Develop

```sh
pnpm install
pnpm test            # risk layer, portfolio rules, regime, brain switching, adapters, news, knowledge, backtester, ...
pnpm typecheck && pnpm lint
pnpm backtest -- --synthetic                   # the backtester on generated data
pnpm e2e:fake-jev    # the whole engine on paper with a random fake chooser (no spend)
pnpm dev             # the real engine on paper (Setup runs if nothing is configured)

cd dashboard && pnpm install && pnpm dev       # http://127.0.0.1:5173, proxied to the engine
```

Everything on OKX goes through OKX's open-source [Agent Trade Kit](https://github.com/okx/agent-trade-kit) (MIT), as in
beebots. Keys never touch disk inside the container except in the Setup file (`/data/settings.json`, owner-only); the
logger and the event stream redact anything that looks like a key, an IP address or an email.

## Credits and licence

WaspBot is built on [beebots](https://github.com/imikerussell/beebots) by Mike Russell (Creator Magic), MIT licence.
WaspBot's changes are MIT as well. No warranty. Not financial advice.
