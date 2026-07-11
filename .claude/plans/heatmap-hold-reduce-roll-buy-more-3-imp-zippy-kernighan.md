# Implementation Plan: Real-Time Monitoring Dashboard for PositionsActionBoard

## Overview

Replace the removed heatmap area in PositionsActionBoard.jsx with an interactive monitoring dashboard. When the user clicks a product row in any ActionSection (HOLD/REDUCE/ROLL/BUY_MORE), a dashboard panel appears showing 3 switchable tables: Expiry P&L, Time Decay, and Drawdown Analysis.

---

## 1. Component Architecture

### New Files to Create

**`web/src/components/ProductMonitoringDashboard.jsx`** — Main dashboard component containing the Tabs wrapper and all 3 table sub-components. This is a new file.

**`web/src/utils/productCalculations.js`** — Pure functions for all 3 calculation types (expiry P&L, time decay, drawdown). Extracted to a utility module for testability and reuse.

### Files to Modify

**`web/src/components/PositionsActionBoard.jsx`** — Add row-click state, pass it downstream, and render the new dashboard component between the header and the action sections.

### Component Tree (Post-Change)

```
PositionsActionBoard
  ├── Header (unchanged)
  ├── Loading indicator / Error alert (unchanged)
  ├── [NEW] ProductMonitoringDashboard (only when selectedProduct != null)
  │     ├── Tabs (MUI Tabs: 3 tabs)
  │     ├── TabPanel 1: ExpiryPnlTable
  │     ├── TabPanel 2: TimeDecayTable
  │     └── TabPanel 3: DrawdownTable
  └── ActionSection x 4 (unchanged)
        └── ProductActionTable (modified: add onRowClick)
              └── DataGrid (rows remain unchanged)
```

---

## 2. MUI Component Choices with Justification

| Component | Purpose | Why |
|-----------|---------|------|
| `Tabs` + `Tab` from `@mui/material` | Tab switching between the 3 tables | Already in @mui/material core (no @mui/lab needed). Native accessibility (ARIA tabs pattern), keyboard navigation, indicator animation. |
| `Table`, `TableBody`, `TableCell`, `TableContainer`, `TableHead`, `TableRow` from `@mui/material` | Tabular display of scenario data | Lighter weight than DataGrid for static scenario rows. Same components used in WatchlistTable.jsx, InstrumentList.jsx. Consistent styling with existing code. |
| `TextField` from `@mui/material` | Editable scenario price / manual input | For allowing users to override auto-generated scenario prices. MUI core, supports type="number", InputAdornment, size="small". |
| `Chip` from `@mui/material` | Visual indicators for calculation method | Already heavily used in the codebase. Show "delta", "omega", "linear" as method labels. |
| `Tooltip` from `@mui/material` | Explain calculations on hover | Existing pattern matches the RiskSignal tooltip pattern. |
| `Box`, `Stack`, `Typography` from `@mui/material` | Layout and labels | Core layout components, consistent with existing usage. |
| `IconButton` from `@mui/material` | Close/deselect button | Close icon to deselect the product and hide the dashboard. |
| `Collapse` from `@mui/material` | Optional: animate dashboard appearance | Matches how ActionSection expands/collapses. |
| `InputAdornment` from `@mui/material` | Currency/EUR suffix on editable fields | Professional UX for scenario price fields. |

**Not using**:
- `DataGrid` — 3 tables have fixed structure (scenario rows), no need for sorting/filtering/pagination.
- `@mui/x-charts` — Not needed for tabular data. Could be considered as a future enhancement for visual P&L charts.
- `@mui/lab` — Not installed; Tabs from core is sufficient.

---

## 3. Data Flow and State Management

### State in PositionsActionBoard

Add to the component body (alongside expandedActionIds):

```jsx
const [selectedProduct, setSelectedProduct] = useState(null)
// selectedProduct = { item, riskLeg, group, riskGroup, primaryAction, exposurePct } | null
```

### Row Click Handler

- `ProductActionTable` receives `onRowClick` prop.
- DataGrid gets `onRowClick={({ row }) => onRowClick?.(row)}`.
- The handler in PositionsActionBoard does: clicking same row deselects; clicking different row switches.

### Dashboard Placement

Inside the main Stack, BETWEEN the error alert and the first ActionSection:

```jsx
{selectedProduct ? (
  <ProductMonitoringDashboard
    item={selectedProduct.item}
    riskLeg={selectedProduct.riskLeg}
    onClose={() => setSelectedProduct(null)}
  />
) : null}
```

### Data Flow Diagram

```
PositionsActionBoard
  |
  +-- state: selectedProduct = { item, riskLeg, ... }
  |
  +-- ProductActionTable(onRowClick) --> setSelectedProduct(row)
  |
  +-- ProductMonitoringDashboard(item, riskLeg, onClose)
        |
        +-- productCalculations.js (pure functions)
        |     +-- calculateExpiryPnl(item, scenarioPrice)
        |     +-- calculateTimeDecay(item, days)
        |     +-- calculateDrawdown(item, underlyingChangePct)
        |
        +-- state: activeTab (0 | 1 | 2) -- from useState, no URL sync needed
        +-- state: scenarioPercentages (array of -10, -5, -3, 0, +3, +5, +10)
              +-- optional: manualScenarioPrices (Map of editable overrides)
```

---

## 4. Calculation Logic -- productCalculations.js

All functions are pure, accepting a product `item` object and numeric parameters. They return either a result object or `null` for missing data.

### 4a. Direction/Option Type

```js
function getOptionDirection(item) {
  const text = `${item.stockName || ''} ${item.instrument || ''} ${item.displayName || ''}`.toLowerCase()
  if (/put|bear|short|turbop|fakts/i.test(text)) return 'put'
  if (/call|bull|long|turboc|faktl/i.test(text)) return 'call'
  return null
}
```

### 4b. Expiry P&L

```
Given: strike, ratio, avgCost (costBasis/quantity), qty, direction
For CALL: intrinsic = max(0, scenarioUnderlying - strike) / ratio
For PUT:  intrinsic = max(0, strike - scenarioUnderlying) / ratio
pnl = (intrinsic - avgCost) * qty
pnlPct = pnl / (avgCost * qty) * 100 if avgCost > 0

Returns { intrinsic, pnl, pnlPct } or null
```

### 4c. Time Decay

```
Priority order:
1. With Theta:     priceChange = theta * days (theta in warrant price units per day)
2. Linear amort:   timeValue = currentPrice - intrinsicValue
                   dailyDecay = timeValue / daysToExpiry
                   priceChange = -dailyDecay * min(days, daysToExpiry)
3. Approximation:  priceChange = -currentPrice * (days / daysToExpiry) * 0.5

Returns { currentPrice, newPrice, priceChange, pnlChange, method, days } or null
```

### 4d. Drawdown

```
Priority order:
1. With Delta:     underlyingChange = spot * (changePct / 100)
                   priceChange = delta * (underlyingChange / ratio)
2. With Omega:     pctChange = omega * (changePct / 100)
                   priceChange = currentPrice * pctChange
3. Intrinsic:      extrinsic assumed constant, recompute intrinsic at new spot

For CALL: adverse scenarios are negative % (underlying drops)
For PUT:  adverse scenarios are positive % (underlying rises)

Returns { currentPrice, newPrice, priceChange, pnl, pnlPct, method } or null
```

### 4e. Scenario Generation

```js
const DEFAULT_SCENARIO_PCTS = [-10, -5, -3, 0, 3, 5, 10]

function generateScenarioPrices(spot, customPcts) {
  const pcts = customPcts || DEFAULT_SCENARIO_PCTS
  if (!Number.isFinite(spot)) return []
  return pcts.map((pct) => ({
    pct,
    price: spot * (1 + pct / 100),
    label: pct > 0 ? `+${pct}%` : `${pct}%`,
  }))
}

function getAdverseScenarioPcts(direction) {
  if (direction === 'put') return [1, 2, 3, 5, 10]
  return [-1, -2, -3, -5, -10]
}
```

---

## 5. UI Layout and Interaction Design

### 5a. ProductMonitoringDashboard Layout

```
+------------------------------------------------------------------+
| [product name] [symbol] [CALL/PUT] [optionsschein]          [x]  |  Header
| Spot: 123.45  Strike: 100.00  Exp: 2026-08-15  Qty: 5  DTE: 47  |  Context bar
+------------------------------------------------------------------+
|  [到期收益]  [时间损耗]  [回撤分析]                                  |  Tabs
+------------------------------------------------------------------+
|                                                                  |
|  Tab content (one of 3 tables below)                             |
|                                                                  |
+------------------------------------------------------------------+
```

### 5b. Tab 1: Expiry P&L Table

```
Scenario Prices (auto-generated, editable):
  [111.11] [117.28] [119.55] [123.45] [127.15] [129.62] [135.80]
   -10%     -5%       -3%        0%      +3%       +5%      +10%

Scenario     Intrinsic     P&L        P&L%        Change
111.11       11.11         55.55      +12.3%      -10%
117.28       17.28         86.40      +19.1%      -5%
123.45       23.45         117.25     +25.9%       0%  (current)
135.80       35.80         179.00     +39.6%      +10%

Formula: intrinsic = max(0, scenario - strike) / ratio
P&L = (intrinsic - avg_cost) * quantity
```

Each scenario price in the top row is an editable TextField. Changing a value recalculates that row in real-time using useMemo.

### 5c. Tab 2: Time Decay Table

```
Period     Days    Price Change    New Price    Position P&L    Method
1 week      7      -0.42           5.83         -2.10           [Theta]
2 weeks     14     -0.84           5.41         -4.20           [Theta]
1 month     30     -1.80           4.45         -9.00           [Theta]
3 months    90     -5.40           0.85         -27.00          [Theta]

Current price: 6.25 | Theta: -0.06 | Days to expiry: 120
```

Method chip color: green for theta, amber for linear, grey for approx.

### 5d. Tab 3: Drawdown Table

```
Underlying    New Price    Price Change    P&L          P&L%        Method
-1%           6.12         -0.13          -0.63        -2.0%       [Delta]
-2%           5.99         -0.26          -1.26        -4.0%       [Delta]
-3%           5.86         -0.39          -1.89        -6.0%       [Delta]
-5%           5.61         -0.64          -3.15        -10.1%      [Delta]
-10%          4.96         -1.29          -6.30        -20.2%      [Delta]

Current price: 6.25 | Delta: 0.20 | Spot: 123.45
P&L based on delta linear estimation, ignores gamma curvature
```

For PUT products: scenarios are +1%, +2%, +3%, +5%, +10% (adverse = underlying rises).

---

## 6. Edge Cases and Their Handling

| Edge Case | Detection | Handling |
|-----------|-----------|----------|
| Null strikePrice | `!Number.isFinite(item.strikePrice)` | Tab 1 disabled with banner "缺少行权价信息，无法计算到期收益" |
| Null price (warrant) | `!Number.isFinite(item.price)` | All tabs show "产品无当前报价" |
| Null underlyingSpot | `!Number.isFinite(item.underlyingSpot)` | Scenario prices not auto-generated. Show manual input only. |
| Null ratio or ratio=0 | `ratio === 0` | Tab 1/2 disabled: "缺少比例(Bezugsverhaltnis)数据" |
| Null theta | `!Number.isFinite(item.theta)` | Fallback to linear amortization. Show amber [Linear] chip. |
| Null delta AND null omega | `!isFinite(delta) && !isFinite(omega)` | Tab 3 uses intrinsic fallback. Show grey [Intrinsic] chip. |
| No expiry (open_end_turbo, factor_certificate) | `item.productType` check | Tab 2 shows "无到期日" message. Tab 1 still works if strike exists. |
| Put with positive delta | `direction==='put' && delta > 0` | Negate delta: use -Math.abs(delta) on calculation |
| Quantity = 0 or null | `qty === 0` | Show "当前无持仓". Per-unit values still displayed. |
| Non-EUR currency | `item.currency === 'USD'` | Show "USD -> EUR: {rate}" note. Use item.usdEurRate. |
| Null daysToExpiry on riskLeg | `riskLeg?.daysToExpiry == null` | Compute from item.expiry date string. |
| Very small/large numbers | | Use Intl.NumberFormat de-DE with appropriate precision. |
| Negative calculated price | `newPrice < 0` | Clamp to 0. Tooltip: "产品可能已到期". |
| Product type factor_certificate | No expiry, no strike | Tab 1 shows "产品无行权价". Tab 2 shows "无到期日". Tab 3 still works with omega/leverage. |
| Manual scenario price < 0 | User input validation | Clamp to 0, show validation error. |

---

## 7. Styling Conventions

Match exactly the existing patterns in PositionsActionBoard.jsx:

- **Container border**: `border: '1px solid #e5eaef'`, `borderRadius: 2`, `overflow: 'hidden'`
- **Dashboard header**: `backgroundColor: '#f8fafc'`, `px: 1.5`, `py: 1`, `borderBottom: '1px solid #e5eaef'`
- **Table header row**: `backgroundColor: '#f8fafc'`, `fontWeight: 800`
- **Table cells**: `fontSize: '0.8rem'`, `py: 0.75`, `px: 1`
- **Typography**: `fontWeight: 800` for labels, `fontWeight: 700` for data values
- **Empty/NA**: `color="text.disabled"` with `--` placeholder
- **Numeric**: `fontVariantNumeric: 'tabular-nums'`
- **Negative values**: `color="error.main"`, positive: `color="success.main"`
- **Chip styling**: `height: 20`, `'& .MuiChip-label': { px: 0.75, fontSize: '0.7rem' }`

### Tab Styling

```jsx
<Tabs
  value={activeTab}
  onChange={(_, v) => setActiveTab(v)}
  sx={{
    minHeight: 36,
    px: 1.5,
    '& .MuiTab-root': {
      minHeight: 36,
      py: 0.5,
      fontSize: '0.8rem',
      fontWeight: 700,
      textTransform: 'none',
    },
  }}
>
  <Tab label="到期收益" />
  <Tab label="时间损耗" />
  <Tab label="回撤分析" />
</Tabs>
```

---

## 8. File-by-File Changes

### 8a. CREATE: `web/src/utils/productCalculations.js`

Contains all pure calculation functions:

- `getOptionDirection(item)` -- returns 'call' | 'put' | null
- `calculateExpiryPnl(item, scenarioPrice)` -- returns { intrinsic, pnl, pnlPct } | null
- `calculateTimeDecay(item, days)` -- returns { currentPrice, newPrice, priceChange, pnlChange, method } | null
- `calculateDrawdown(item, underlyingChangePct)` -- returns { currentPrice, newPrice, priceChange, pnl, pnlPct, method } | null
- `generateScenarioPrices(spot, customPcts)` -- returns [{ pct, price, label }]
- `getAdverseScenarioPcts(direction)` -- returns array of percentage changes
- `daysUntil(dateString)` -- helper: returns integer days from today to date
- `METHOD_LABELS` -- map: { theta: 'Theta', linear: 'Linear', approx: 'Approx', delta: 'Delta', omega: 'Omega', intrinsic: 'Intrinsic' }

All functions use `Number.isFinite()` guards. No React dependencies -- pure JS.

Approximate size: 180-200 lines.

### 8b. CREATE: `web/src/components/ProductMonitoringDashboard.jsx`

Main component with internal sub-components following the pattern of PositionsActionBoard.jsx (all in one file):

**`ProductMonitoringDashboard({ item, riskLeg, onClose })`**
- Guards: if !item return null
- State: `activeTab` (useState 0)
- Optional manual scenario percentages state
- Renders Header, ContextBar, Tabs, and active tab panel

**`DashboardHeader({ item, onClose })`**
- Stock name, symbol, product type chip, CALL/PUT chip
- Close button (x icon)

**`DashboardContextBar({ item, riskLeg })`**
- Key metrics row: underlying spot, strike, expiry, quantity, DTE, delta
- Compact Chip-based layout

**`ExpiryPnlTable({ item })`**
- State: editable scenario prices
- useMemo: compute scenario prices + P&L for each
- Renders: editable price bar + table
- Guards: no strike/ratio = show disabled message

**`TimeDecayTable({ item, riskLeg })`**
- useMemo: compute 4 scenarios (1 week, 2 weeks, 1 month, 3 months)
- Renders: table with method chips
- Guards: no expiry + no theta = show "not applicable"

**`DrawdownTable({ item })`**
- useMemo: compute adverse scenarios
- Renders: table with method chips
- Guards: no price/spot = show disabled message

**`MethodChip({ method })`**
- Chip with color-coded label
- Green for theta/delta (preferred), amber for linear/omega, grey for approx/intrinsic

Approximate size: 400-450 lines.

### 8c. MODIFY: `web/src/components/PositionsActionBoard.jsx`

Changes are surgical and minimal:

**Import** (add with existing imports):
```jsx
import ProductMonitoringDashboard from './ProductMonitoringDashboard.jsx'
```

**State** (add at line ~79):
```jsx
const [selectedProduct, setSelectedProduct] = useState(null)
```

**Handler** (add after toggleSection, line ~107):
```jsx
const handleRowClick = (row) => {
  setSelectedProduct((current) => {
    if (current?.item?.id === row.item.id) return null // toggle off
    return row
  })
}
```

**Render dashboard** (add inside `<Stack>`, between riskError Alert and sections map):
```jsx
{selectedProduct ? (
  <ProductMonitoringDashboard
    item={selectedProduct.item}
    riskLeg={selectedProduct.riskLeg}
    onClose={() => setSelectedProduct(null)}
  />
) : null}
```

**Pass onRowClick through ActionSection**:
- `ActionSection` signature: add `onRowClick` prop
- Pass `onRowClick` to `<ProductActionTable>`

**ProductActionTable**: add `onRowClick` prop and DataGrid `onRowClick`:
```jsx
<DataGrid
  rows={rows}
  columns={tableColumns}
  onRowClick={({ row }) => onRowClick?.(row)}
  // ... existing props unchanged
/>
```

Approximate lines changed: ~25-30 lines.

---

## 9. Implementation Sequencing

| Step | File | Description | Dependencies |
|------|------|-------------|--------------|
| 1 | `productCalculations.js` | Create utility file with all calculation functions | None |
| 2 | `PositionsActionBoard.jsx` | Add selectedProduct state, handleRowClick, pass to ActionSection | None (separate concern) |
| 3 | `PositionsActionBoard.jsx` | Update ProductActionTable to accept onRowClick | None (separate) |
| 4 | `ProductMonitoringDashboard.jsx` | Create main dashboard component with Tabs wrapper | Step 1 for logic |
| 5 | Same file | Implement ExpiryPnlTable sub-component | Step 1 |
| 6 | Same file | Implement TimeDecayTable sub-component | Step 1 |
| 7 | Same file | Implement DrawdownTable sub-component | Step 1 |
| 8 | `PositionsActionBoard.jsx` | Wire ProductMonitoringDashboard rendering into main Stack | Steps 2-7 |
| 9 | Manual verification | Test with real data exported from the app | All steps |

Steps 5, 6, 7 can be developed in parallel since they depend only on Step 1.

---

## 10. Potential Challenges

1. **Delta sign convention**: The delta on `item.delta` is already sanitized by `sanitizeGreek()` in watchlistGrouping.js. For puts, it should already be negative. Verify with actual data during implementation. The drawdown calculation `priceChange = delta * (underlyingChange / ratio)` works correctly when delta has the correct sign.

2. **Theta units**: Theta may be expressed per share of underlying or per warrant. The watchlistGrouping.js code does not sanitize theta. If theta values appear too large (e.g. -0.50 for a 5.00 warrant), it is likely per underlying share and needs division by `ratio`. The implementation should include a heuristic: if `Math.abs(theta * ratio) > currentPrice * 0.5`, theta is likely per underlying share and should be divided by ratio.

3. **DataGrid row click behavior**: The current DataGrid uses `disableRowSelectionOnClick`, so `onRowClick` is the only interaction. Ensure `onRowClick` fires reliably on all click targets within the row (the existing renderCells use nested components).

4. **Tab disabling logic**: Must be computed in `useMemo` based on item data. A helper function `tabAvailability(item)` determines which of the 3 tabs has sufficient data. Disabled tabs are skipped if clicked.

5. **Performance**: The dashboard calculations are lightweight (5-7 scenarios per table). No virtualization or memoization beyond `useMemo` is needed. The dashboard re-renders when `selectedProduct` changes, which is a React state transition -- no performance issue.

6. **Factor certificates**: These products have no strike, no expiry, and use leverage instead. The drawdown tab works well (using omega or leverage). The expiry tab needs to show "不适用 -- Factor Certificate 无行权价". The time decay tab needs to show "不适用 -- Factor Certificate 无到期日".

---

## 11. Summary of Changes

| File | Action | Approx Lines |
|------|--------|--------------|
| `web/src/utils/productCalculations.js` | CREATE | 180-200 |
| `web/src/components/ProductMonitoringDashboard.jsx` | CREATE | 400-450 |
| `web/src/components/PositionsActionBoard.jsx` | MODIFY | +25-30 |

No other files need changes. The props interface of PositionsActionBoard stays the same. PortfolioTabs.jsx and App.jsx are unaffected.
