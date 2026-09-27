# Portfolio stress model

The first revision is a deterministic scenario tool using existing portfolio,
structured-product and Alpaca responses. It neither adds providers nor estimates
probabilities. Default mode is an instantaneous shock; 7/30/90 day modes retain
the existing approximate warrant decay model.

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

The page is a holding/reduction comparison, not an add-position recommendation.
A single table compares retained value, hypothetical released cash, downside/upside
endpoint P&L and worst P&L. Deltas compare each portfolio's own worst outcome and
its same upward endpoint against the current calculable baseline. Selecting a row
shows modeled reductions/exits with before/after weights on common tested capital,
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
10, 20, 30 or 50 percent. For longer horizons two additional synthetic paths reach
that down/up level on one reset period, recover to the starting level on the next,
then remain flat. Factors compound the two returns; a turbo touching its barrier
at either point stays at zero under a conservative zero-recovery assumption.
Options still use the endpoint calculation. The five endpoint scenarios assume
a single terminal shock, including for factors. Daily financing, intraday resets,
actual settlement terms, FX changes, liquidity and transaction costs are omitted.

All candidates retain the baseline tested capital: unselected/reduced positions
become zero-return hypothetical cash. The table shows return on that common
capital and impact relative to account valuation. Untested positions are retained
but their scenario P&L is unknown, so account impact is partial, not whole-account
VaR. Selection scores remain heuristic and do not optimize probabilities.

Hermes receives common-capital returns and cash/untested context. Single-underlying
reviews remain disabled because the bounded review contract does not identify the
shocked group. A stale review is discarded when its originating report changes.

## Verification

Run `npm --prefix web test`, `npm --prefix web run build`, and
`cargo test portfolio_stress --lib`. Regression cases cover stale valuation,
instantaneous flat shocks, targeting, factor compounding, intermediate knockout,
missing-data coverage and capital conservation with candidate cash.
