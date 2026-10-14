# Backtesting

The backtester replays **the real engine** over stored history: the same trading styles, the same chooser, the same
risk layer, regime filter and portfolio rules, and the same ledger. Nothing is reimplemented for the test, so what you
measure is what would have run.

## Get data

```sh
pnpm backtest:fetch -- --coins BTC,ETH,SOL --days 120
```

This downloads 15-minute candles and funding history from OKX's public API (no key) into `data/backtest/history/`.

- Default: the coin's EEA **X-Perp** (what the wasps trade). X-Perps are young, so history may be short.
- `--swap`: the global **USDT perpetual** (`BTC-USDT-SWAP` on www.okx.com) for longer tests. Prices track closely, but
  fees, funding and liquidity differ. Say which one a result came from (the report's JSON records the source).

## Run

```sh
pnpm backtest -- --coins BTC,ETH,SOL                       # the rules engine, everything stored
pnpm backtest -- --coins BTC,ETH,SOL --split 0.7           # + in-sample / out-of-sample
pnpm backtest -- --coins BTC,ETH,SOL --compare regime      # regime filter on vs off
pnpm backtest -- --coins BTC,ETH --set NET_EXPOSURE_MAX_X=0.5 --set BREEZY_STOP_ATR_MULT=3
pnpm backtest -- --synthetic                               # generated data: checks the pipeline, says nothing about markets
pnpm backtest -- --help
```

`--compare` takes `regime`, `engine` (rules vs the model) or `memory` (trade-memory gate on vs off). `--set` takes any
`.env` knob. The report goes to `data/backtest/reports/` as JSON and a self-contained HTML page with equity curves.

## What is modelled

- **Time:** a simulated clock steps 15 minutes at a time. Before each step the engine refreshes its market view; 1h and
  4h bars are built from 15m bars that have **closed**, and the current hour's bar only from its closed quarters.
  Nothing after the clock is ever visible.
- **Fills:** taker market orders at the bid (sells) or ask (buys), with a spread around each close (`--spread-bps`,
  default 2) and extra adverse slippage (`--slippage-bps`, default 2).
- **Fees:** the taker fee (`TAKER_FEE_RATE`, 0.05%) on every fill.
- **Funding:** charged or paid every 8 hours at the historical rate (or 0.01% when the history has none).
- **Warm-up:** the first 10 days only feed the indicators.
- **Portfolio breaker:** if it trips on a drawdown, the backtest stays halted, as the live engine would until you
  pressed Resume. The report says when.

## What is not modelled

- **Intrabar stops.** Stops are checked on 15-minute closes. A move through a stop fills at the close, usually worse
  than the stop. Live, the exit watch checks every 2 seconds.
- **Historical news.** There is none, so the news digest is off. Calendar events can be applied with `--events`.
- **Liquidity and queue.** Every order fills in full at the touch plus slippage. Large sizes on thin coins would not.
- **Exchange outages, rejections, partial fills.**
- **Open interest** (no history): the open-interest change is always unknown in backtests.

## Models in backtests

`--engine llm` (or `--compare engine`) asks a real model for every decision, with your key from the environment:

```sh
ANTHROPIC_API_KEY=... pnpm backtest -- --coins BTC,ETH --days 30 --compare engine --max-llm-usd 5
```

- It **refuses to spend** without `--max-llm-usd`; when the budget runs out, the rules engine takes over and the report
  says when.
- **Results are contaminated.** A model trained on the internet may have read about the very period it is trading
  (the ETF approval, the crash, the rally). A model that "knows" the future looks smart in a backtest and is not. Only
  trust a model comparison on data from **after** the model's training cutoff, and even then, mostly trust paper
  trading.

## Reading the report

| Metric | Meaning |
|---|---|
| return / CAGR | total and annualised, after fees, slippage and funding |
| Sharpe / Sortino | daily returns, annualised over 365 days (crypto trades every day) |
| max DD | the deepest fall from a previous peak |
| trades, win, avg R, PF | closed trades, share that made money, average result in R (net P&L ÷ risk at entry), gross wins ÷ gross losses |
| fees, funding | total paid (positive funding = received) |
| in mkt | share of time with a position open |

Habits that keep you honest:

1. **Compare with buy-and-hold.** The bottom row holds BTC with the same money. A strategy that loses to it with more
   risk is not worth the fees.
2. **Look at fees.** Many trades with a small average R are usually fee drag in disguise. Cutting trades often helps
   more than any signal.
3. **Use `--split`.** If out-of-sample is much worse than in-sample, the settings were fitted to noise.
4. **Change one thing at a time** with `--compare` or `--set`, and do not keep tuning until the number looks good: that
   is overfitting, and the market will not repeat the same path.
5. **Run `--synthetic`.** On a random walk the styles have no edge, so the result should be about minus the costs. A
   strongly positive result there would mean a bug.

A backtest is not a forecast. Not financial advice.
