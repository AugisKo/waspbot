# Risk rules: shared by all three wasps

These replace beebots' "drama rules". The drama rules were written to keep a video interesting: a bee was never to sit
in cash for long, and forced entries made most of the official bees' trades and lost money. Here the goal is the
opposite: **a wasp with no good setup stays flat**, and every rule below is enforced in code, in the risk layer
(`src/risk.ts`), whatever the chooser says.

## 1. The chooser picks, code decides

- The chooser (the rules engine or a model) picks one move from a menu of moves that are valid right now. It never sees
  an order endpoint.
- The risk layer can veto, shrink or force (close) a move. It can never open a position that the chooser did not pick.
- Every decision is recorded with who made it, and why anything was vetoed or forced, before anything happens.

## 2. Per wasp

| Rule | Default | Setting |
|---|---|---|
| Max leverage | 2x (hard) | `MAX_LEVERAGE` (≤ 2) |
| Max position | $700 | `MAX_NOTIONAL_USD_PER_BEE` |
| Stop | ATR multiple per style, only ratchets in the wasp's favour; profit lock rungs | `*_STOP_ATR_MULT` |
| Time stop | per style (Breakout 4 h) | `BIZZY_TIME_STOP_MINUTES` |
| Trades per day | 4 / 2 / 3 | `*_MAX_TRADES_PER_DAY` |
| Fee budget per day | $1.20 / $0.75 / $1.50 | `*_FEE_BUDGET_USD_DAY` |
| Cooldown after an order | 30 / 240 / 60 min | `*_COOLDOWN_MINUTES` |
| Daily loss stop | 8% → flat until 00:00 UTC | `DAILY_LOSS_STOP_PCT` |
| Retirement | below 40% of start → flat for good | `BEE_RETIRE_AT_PCT` |
| Spread gate | 5–8 bp | `*_SPREAD_GATE_BPS` |
| Funding veto | no longs into extreme funding | per style |

A benched wasp (trade cap or fee budget) rides what it holds; only stops close it until 00:00 UTC.

## 3. Across the portfolio

| Rule | Default | Setting |
|---|---|---|
| Breaker: drawdown from the peak of total equity | 20% → everything flat, **holds until the owner resumes** | `PORTFOLIO_MAX_DRAWDOWN_PCT` |
| Breaker: loss on the day | 6% → everything flat until 00:00 UTC | `PORTFOLIO_DAILY_LOSS_PCT` |
| Net exposure | \|net notional of all wasps\| ≤ 1 × total equity; new trades are shrunk to fit | `NET_EXPOSURE_MAX_X` |
| Crowding | at most 2 wasps in one coin on one side | `SAME_COIN_MAX_WASPS` |
| Stale data | market data older than 10 min closes open positions | `STALE_FLATTEN_MINUTES` |

Resume after a drawdown halt from **Controls** on the dashboard (owner password). The peak is reset to the equity at
that moment, so the breaker measures from there.

## 4. Market regime

Each coin's regime comes from 1-hour bars (`src/market/regime.ts`):

- **trend**: ADX(14) ≥ 22 and a 24-bar efficiency ratio ≥ 0.3, with a direction (up or down over 24 hours);
- **chop**: no trend, and the current ATR in the top 20% of the last week;
- **range**: anything else.

With `REGIME_FILTER=true`:

| Style | Opens only when |
|---|---|
| Trend (Vespa) | the coin trends in the trade's direction |
| Momentum (Hornet) | the coin trends in the trade's direction |
| Breakout (Jacket) | the coin is not in chop (it fades ranges and takes breakouts) |

Not enough history to tell never vetoes. Compare with and without: `pnpm backtest -- --compare regime`.

## 5. Knowledge

The knowledge layer (news digest, event calendar, trade memory) comes last and can only veto or shrink an opening
trade: see [docs/KNOWLEDGE.md](../docs/KNOWLEDGE.md).

## 6. Never allowed

- Leverage above 2x.
- Resting limit orders (self-trade prevention would cancel them silently across wasps).
- Any key with withdraw or transfer permission.
- Stocks or commodities before their trading hours are verified (`ALLOW_NON_CRYPTO=false`).
- Real money without `DRY_RUN=false`, `MODE=live`, per-wasp live keys and `LIVE_ACK`.
