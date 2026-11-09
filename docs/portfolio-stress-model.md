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

The page compares the current holdings with candidates that reallocate the same
tested capital; candidates are modeled structures, not trade instructions. A
single table compares invested value, remaining hypothetical cash, downside/upside
endpoint P&L and worst P&L. Deltas compare each portfolio's own worst outcome and
its same upward endpoint against the current calculable baseline. Selecting a row
shows modeled increases, reductions and exits with before/after weights on common
tested capital,
then optional scenario-specific loss and offset contributions. Full membership,
all scenario results, monitoring and methodology are expandable details. Zero
instantaneous P&L with no target exposure is labeled explicitly rather than shown
as an apparently empty portfolio. Product contributions use the sized positions
and reconcile to scenario P&L; hypothetical cash earns zero.

The page first displays candidate holdings, weights, value and hypothetical cash.
Stress testing is optional and off by default. Candidate scores use a fixed 30-day,
all-underlying ±10% reference and existing risk rules. Changing the displayed shock
range, amplitude or horizon only revalues those members; IDs, sizing and cash stay
stable. New input data regenerates the candidates. Products lacking expiry inputs
needed within the supported 90-day horizon are omitted consistently and reported
in coverage, rather than disappearing when a longer stress horizon is selected.

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
[portfolio-candidate-policy.md](portfolio-candidate-policy.md) for formulas and
assumptions. Actual issuer financing terms, intraday resets, actual settlement
terms, FX changes, liquidity and transaction costs are omitted.

All candidates use the baseline tested capital. It is split equally across the
selected products, subject to the 8% exposure cap; WATCH, SELL or
unknown-exposure products are not increased. Capital no product can absorb is
zero-return hypothetical cash. The table shows return on that common
capital and impact relative to account valuation. Untested positions are retained
but their scenario P&L is unknown, so account impact is partial, not whole-account
VaR. Selection scores remain heuristic and do not optimize probabilities. The
eligibility, scoring, allocation and selection rules are documented in
[portfolio-candidate-policy.md](portfolio-candidate-policy.md).

Hermes receives common-capital returns, cash/untested context and an
`assumptions` string describing the active shock settings. Single-underlying
reviews remain disabled because the bounded review contract does not identify the
shocked group. A stale review is discarded when its originating report changes.

## Verification

Run `npm --prefix web test`, `npm --prefix web run build`, and
`cargo test portfolio_stress --lib`. Regression cases cover stale valuation,
instantaneous flat shocks, targeting, factor compounding, intermediate knockout,
missing-data coverage, capital conservation with candidate cash, Black-Scholes
revaluation against reference values, the provider-IV fallback, volatility and
currency shocks, volatility-scaled moves and the adverse scenario.
