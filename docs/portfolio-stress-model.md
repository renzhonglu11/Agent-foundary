# Portfolio stress model

The first revision is a deterministic scenario tool using existing portfolio,
structured-product and Alpaca responses. It neither adds providers nor estimates
probabilities. Default mode is an instantaneous shock; 7/30/90 day modes move the
valuation date forward.

## Warrant revaluation

A warrant that expires after the stress horizon is fully revalued with
Black-Scholes (`web/src/utils/optionPricing.js`) instead of extrapolating Delta
and Theta, so large shocks keep their convexity and time decay accelerates
towards expiry. For an out-of-the-money call the linear estimate overstated a
-20% shock by roughly 20 points and understated a +50% shock by about 100.

- Volatility is calibrated to the current quote (method `bs`). Strike and spot
  are both in EUR, the rate is the reference rate of the underlying's quote
  currency, exercise is European and dividends are ignored; calibration absorbs
  what these simplifications miss at the current spot.
- If no volatility between 5% and 300% reproduces the quote, or the result is
  more than 2x away from the provider IV, the provider IV is used (`bs_iv`).
  This is common deep in the money, where a small quote/spot mismatch calibrates
  to an absurd volatility.
- The model change is added to the quote, so an unchanged scenario returns the
  quote. When the model value exceeds the quote, the change is scaled down to
  the quote's size, so a stale spot or wrong ratio cannot wipe out the position.
- Without strike, ratio, direction or any usable volatility, the previous
  Delta / Omega / intrinsic chain still applies.
- A warrant expiring within the horizon is valued at intrinsic value as before.

## Valuation and coverage

P0 adds authoritative valuation-source fields and background data-quality monitoring;
see [P0 implementation](portfolio-monitoring-p0.md). Production stress entries now
use the summary-selected product price and current quantity, and exclude enrichment
for positions no longer held. Direct product-price stress uses authoritative summary
market values where available. The denominator is holdings value, not cash-inclusive
account NAV. Market timestamps and fetch/import timestamps are displayed separately.

Tested holdings use product quote times quantity, not enrichment's previously
calculated market value. The account denominator is rebuilt from the supplied
positions using the same product overrides; other positions keep summary quotes
and bonds keep summary market values. Quote timestamps are exposed as a range,
with unknown counts. Frankfurt timestamps mean fetch time, not exchange trade time.
This does not make asynchronous provider snapshots simultaneous.

Underlying scenarios still cover calculable Tier 1 action entries only. Missing
entries are listed separately from candidate exclusions. Untested account value
is explicitly displayed and is not assumed risk-free. A separate direct product
price stress of -20/-50/-100 percent covers supplied portfolio valuations without
requiring underlying prices or Greeks; it is not the same as an underlying shock.

## Scenarios and comparisons

The page compares the current holdings with plans that trim them. A plan maps
products to the share sold (`options.plans` of `buildPortfolioStressReport`); the
proceeds stay in the plan as zero-return cash and nothing is bought, so every
plan uses the same tested capital as the baseline. Plans are modeled structures,
not trade instructions. A single table compares invested value, released cash,
downside/upside endpoint P&L and worst P&L. Deltas compare each plan's own worst
outcome and its same upward endpoint against the baseline. Selecting a row shows
the reductions and exits with before/after weights on common tested capital, then
scenario-specific loss and offset contributions. Full membership, all scenario
results, monitoring and methodology are expandable details. Product
contributions use the sized positions and reconcile to scenario P&L.

Preset plans come from `buildPresetPlans` (`web/src/utils/positionWhatIf.js`):

- sell every product whose exit signal is "优先复核" (see [exit-signals.md](exit-signals.md));
- the same, plus halving every product flagged "留意";
- halve the five largest losers of the baseline's current worst scenario.

The first two do not depend on the shock settings; the third follows the
scenario being viewed. A custom plan collects the reductions the user picks in
the ranking table.

### Reduction ranking

`rankReductions` answers what selling 25%, 50% or all of one product, or of all
products on one underlying, does while everything else stays. It works from the
baseline's per-product scenario P&L, which scales linearly with position size,
and re-chooses the adverse scenario because an underlying's worst direction can
flip when one of its products shrinks. Per row:

- worst-case improvement: change of the portfolio's worst scenario P&L;
- upside given up: change of the P&L in the largest upward endpoint scenario;
- protection efficiency: the first divided by the second. One means a euro less
  loss for a euro less gain;
- worst loss per euro: worst-case improvement divided by the cash released.

A position that gains in the synchronous downward scenario is labeled a hedge
and ranked last, even though the adverse scenario counts it as a loser. Rows can
be ordered by efficiency, by improvement in euros or by worst loss per euro.

Efficiency carries no probability. Under an instantaneous shock, option
convexity makes out-of-the-money warrants look cheap to keep, because they have
little left to lose and much to gain; their cost is time decay. The table
therefore shows the 30-day flat return from the exit signals beside it, and a
30-day horizon prices the decay into every scenario.

Stress testing is on by default. Changing the shock range, amplitude or horizon
only revalues the plans. Products lacking expiry inputs needed within the
supported 90-day horizon are omitted consistently and reported in coverage,
rather than disappearing when a longer stress horizon is selected. Zero
instantaneous P&L with no target exposure is labeled explicitly rather than shown
as an apparently empty portfolio.

When stress testing is enabled, users select synchronous or single-underlying shocks and maximum amplitudes of
10, 20, 30 or 50 percent. Three further controls change the shock itself, never
the membership or sizing of the portfolios:

- **Volatility-scaled moves.** `buildGroupShockScales` takes the median warrant
  IV per underlying and divides it by the median across underlyings, clamped to
  0.4-2.5x. The stated amplitude is then the move of the median underlying;
  underlyings without any warrant IV keep the stated amplitude. Not applied to
  single-underlying shocks.
- **Implied volatility.** A relative change of -20% or +20% applied in every
  scenario. Only warrants revalued with Black-Scholes respond.
- **USD against EUR.** -10% to +10% in every scenario, applied as a multiplier
  to products whose underlying quote is in USD. Other currencies are not
  modeled, and a US-listed proxy for a non-US underlying is treated as USD.

For all-underlying shocks an extra `adverse` scenario lets every underlying take
whichever endpoint move costs that portfolio most, so a call on one underlying
and a put on another no longer offset. It ignores correlation and is an upper
bound on the endpoint scenarios; each portfolio chooses its own directions, and
the scenario counts towards the worst P&L. Single-underlying targets are limited to the underlyings held
by the selected portfolio; selecting a portfolio without the current target
resets the shock to all underlyings. For longer horizons two additional synthetic paths reach
that down/up level on one reset period, recover to the starting level on the next,
then remain flat. Factors compound the two returns; a turbo touching its barrier
at either point stays at zero under a conservative zero-recovery assumption.
Options still use the endpoint calculation. The five endpoint scenarios assume
a single terminal shock, including for factors. For horizons above zero, turbos
accrue assumed financing on the strike (open-end barriers move with it) and
factors pay financing, an index fee and volatility drag; see
[Holding costs](#holding-costs-for-turbos-and-factor-certificates) for formulas
and assumptions. Actual issuer financing terms, intraday resets, actual settlement
terms, FX changes, liquidity and transaction costs are omitted.

The table shows return on the common tested capital and impact relative to
account valuation. Untested positions are retained but their scenario P&L is
unknown, so account impact is partial, not whole-account VaR. Plans ignore
transaction costs, bid-ask spreads and taxes.

Hermes receives common-capital returns, cash/untested context and an
`assumptions` string describing the active shock settings and, for each plan,
how many products it sells and reduces. Single-underlying
reviews remain disabled because the bounded review contract does not identify the
shocked group. A stale review is discarded when its originating report changes.

## Holding costs for turbos and factor certificates

Applied only for horizons above zero (`web/src/utils/carryCost.js`). No data
source supplies issuer terms, so these are assumptions in `CARRY_ASSUMPTIONS`:

| Parameter | Default |
|---|---|
| Reference rate r, by the underlying's quote currency | USD 4%, otherwise EUR 2% |
| Financing spread s | 3% |
| Factor index fee | 1% per year |
| Volatility when no IV is available σ | 50% |

**Turbos (`open_end_turbo`, `knock_out`).** The financing level accrues daily. A
call loses `strike × ratio × (r + s)` per year; a put gains
`strike × ratio × (r − s)`, which is a loss when `s > r`. Without a strike the
financed amount is approximated from leverage: `price × (L − 1)` for calls and
`price × (L + 1)` for puts. An open-end turbo's barrier moves with the financing
level and the knock-out check uses the barrier at the end of the horizon; a
`knock_out` barrier is fixed and interest accrues for at most the remaining
life. Method suffix `+financing`.

**Factor certificates.** The endpoint price is multiplied by

```
exp( ±financing × days/360 − (fee + ½·β(β−1)·σ²) × days/365 )
```

- β is the signed leverage: `L` long, `−L` short.
- Financing: long pays `(L − 1)(r + s)`, short earns `(L + 1)(r − s)`.
- σ is the product's own IV, else the median IV of products on the same
  underlying, else the default. Method suffixes `+carry_iv`, `+carry_group_iv`
  and `+carry_default_vol`.
- The endpoint shock stays a single jump (`1 + β × move`); the volatility drag
  stands for the cost of the underlying moving back and forth meanwhile.

A turbo without strike and without leverage carries no financing cost.

## Model reliability

Every projection names the methods it used, joined by `+`. Their penalties add
up and the worst of the fixed reference scenarios (30 days, all underlyings
−10% to +10%) sets the product's score (`web/src/utils/modelQuality.js`):

| Method component | Penalty |
|---|---|
| `bs`, `delta`, `expiry_intrinsic`, `knockout`, `factor_leverage`, `factor_path`, `theta`, `financing`, `carry_iv` | 0 |
| `carry_group_iv` | 0.02 |
| `bs_iv`, `omega`, `linear` | 0.03 |
| `carry_default_vol` | 0.05 |
| `intrinsic`, `leverage` | 0.06 |
| `approx` | 0.08 |
| `default_leverage` (no leverage data, 1x assumed) | 0.15 |
| unknown component | 0.10 |

A product scoring 0.10 or more is flagged `MODEL_FALLBACK` and shown as
"模型兜底估算" in the membership table. The flag marks results that deserve less
trust; it does not change any P&L. When adding a method component, add its
penalty.

## Verification

Run `npm --prefix web test`, `npm --prefix web run build`, and
`cargo test portfolio_stress --lib`. Regression cases cover stale valuation,
instantaneous flat shocks, targeting, factor compounding, intermediate knockout,
missing-data coverage, capital conservation with candidate cash, Black-Scholes
revaluation against reference values, the provider-IV fallback, volatility and
currency shocks, volatility-scaled moves, the adverse scenario, plan conservation and the
reduction ranking.
