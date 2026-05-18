# Watchlist Tier 分级方案

Date: 2026-05-18

本方案定义 Stock Picks / 选股分析页面里 watchlist 的 Tier 1、Tier 2、Tier 3 分级规则。目标是让前端当前的三张 tier 表从 mock 数据过渡到后端评分结果，并且让每个标的为什么进入某个 tier 可以被解释、复核和调整。

## Goal

Watchlist tier 不是简单的“买入/卖出”标签，而是一个优先级系统：

- Tier 1：当前最值得进入决策流的标的，可以直接触发加仓、减仓、止盈、再平衡或建仓评估。
- Tier 2：质量不错但还差一个关键确认，需要重点跟踪价格、催化剂、估值或数据完整性。
- Tier 3：观察池或风险池，暂时不进入交易决策，只保留监控、复核或资料补全。

每个 row 应该同时返回：

- `tier`
- `tierScore`
- `scoreBreakdown`
- `tierReason`
- `actionLabel`
- `nextReviewAt`
- `watchTriggers`
- `blockingIssues`
- `derivativeExposure`

## Current UI Baseline

当前 `StockAnalysisTab` 已经有三组静态 mock 数据：

- Tier 1：NVDA、MSFT、ASML
- Tier 2：AMZN、GOOGL、LLY
- Tier 3：TSLA、INTC、NKE

当前表格字段包括股票名称、symbol、价格、目标价格、评级、API 状态、持有状态、持有天数。后端分级时可以继续保留这些字段，但应该补充评分解释和数据来源状态。

## Scoring Model

总分 100 分。建议后端先用规则评分，之后如果接入外部 LLM 研报，可以把 LLM 输出转成这些结构化维度，而不是直接让 LLM 决定 tier。

| Dimension | Weight | Purpose |
| --- | ---: | --- |
| Conviction | 25 | 评级、基本面质量、长期趋势、商业质量、财报稳定性 |
| Valuation Gap | 20 | 当前价格到目标价的空间、安全边际、估值分位 |
| Momentum And Timing | 15 | 近期趋势、相对强度、财报/事件窗口、价格是否接近触发区 |
| Portfolio Fit | 20 | 当前仓位、集中度、分散效果、持有天数、是否已有替代暴露 |
| Data Quality | 10 | Trading 212 / Trading Republic / Alpaca / yfinance / PDF 数据完整度和新鲜度 |
| Catalyst And Review Urgency | 10 | 明确催化剂、复核时间、止盈止损/加仓触发条件 |

### Conviction

- `强烈买入`：22-25
- `买入`：17-21
- `持有`：10-16
- `观望`：5-12
- `卖出`：0-6

如果评级来自外部 LLM，需要保留原始结论、关键理由和置信度。评级缺失时默认不超过 12 分。

### Valuation Gap

用 `(targetPrice - price) / price` 计算目标价空间：

- `>= 25%`：18-20
- `15% - 25%`：14-17
- `8% - 15%`：9-13
- `0% - 8%`：4-8
- `< 0%`：0-3

如果目标价缺失，最多 8 分。如果目标价明显过期或来源不可解释，最多 10 分。

### Momentum And Timing

建议由价格趋势、短中期均线、相对强度、财报窗口和用户设定触发价共同决定：

- 趋势向上且接近计划买点/加仓点：12-15
- 趋势健康但价格不在理想操作区：8-11
- 横盘或缺少确认：4-7
- 趋势转弱或事件风险临近：0-3

没有市场数据时最多 5 分。

### Portfolio Fit

Portfolio Fit 不是“已有仓位越多越好”，而是看这个标的是否适合当前组合：

- 空仓但符合配置方向，且仓位空间充足：15-20
- 已持有且仓位合理，可以继续加仓或持有：12-18
- 已持有但仓位偏高，只适合观察或减仓：5-11
- 与现有持仓高度重叠、风险集中、或不适合账户交易：0-6

建议用当前组合中 `holdingWeight`、行业/主题暴露、持有天数和盈亏状态一起判断。

### Data Quality

- Trading 212 / Trading Republic / Alpaca / yfinance 至少两个来源成功，价格新鲜，身份映射明确：8-10
- 一个外部来源成功，关键字段完整：6-7
- 只有部分研究字段或价格字段成功：3-5
- PDF-only、本地旧数据、identity ambiguous：0-2

PDF fallback 可以用于补全名称、ISIN、持仓和历史记录，但不能作为 fresh research 的强证据。

如果 row 来自 Trading Republic 的期权、warrant、knock-out、turbo 或其他衍生品，Data Quality 需要拆成两层判断：

- 正股映射质量：是否能明确找到 underlying symbol / ISIN。
- 衍生品合约质量：是否能解析方向、strike、expiry、multiplier、issuer、barrier、knock-out 状态和币种。

正股映射不清晰时，不能把衍生品直接并入正股 tier。衍生品合约信息不完整时，可以影响 action urgency，但不能独立支持 Tier 1。

### Catalyst And Review Urgency

- 有明确催化剂和触发条件，例如财报后复核、跌到目标买入区、突破关键位、仓位超过阈值：7-10
- 有大致观察方向但没有精确触发价/日期：4-6
- 没有下一步动作：0-3

## Option To Stock Conversion

Trading Republic 里的期权类产品不要作为单独股票进入主 watchlist。后端应该先把它们解析成“正股主标的 + 衍生品子仓位”，再让正股参与 Tier 1/2/3 评分。

### Normalization Goal

输入可能是：

- Trading Republic option / warrant / turbo / knock-out 产品。
- PDF 或交易流水中只有 issuer、产品名、ISIN/WKN、数量、价格、市值的信息。
- 产品名里带有 `Call`、`Put`、strike、expiry、underlying name 的结构化或半结构化描述。

输出应该是：

- 一个正股主 row，例如 `NVDA`、`MSFT`、`ASML`。
- 一个或多个 derivative legs，挂在正股 row 的 `derivativeExposure.legs` 下。
- 一个转换后的正股等效暴露，用于 Portfolio Fit、风险集中度和 actionLabel。

### Identity Mapping

解析顺序建议如下：

1. Trading Republic instrument metadata：优先使用 broker 提供的 underlying ISIN、underlying symbol、product type、strike、expiry、multiplier、currency。
2. PDF/CSV 产品名解析：从产品名里识别 issuer、underlying name、`Call` / `Put`、strike、expiry、barrier。
3. 外部 symbol lookup：用 underlying name / ISIN 去 yfinance、Alpaca 或已有 portfolio symbol map 里找正股。
4. 人工映射表：对无法自动识别的产品维护 `derivative_symbol_map`，例如 `{ "DE000...": "NVDA" }`。
5. 如果仍无法确定正股，保留为 `unmapped_derivative`，最高 Tier 3。

不要只靠模糊名称把衍生品合并到正股；至少需要 underlying ISIN、明确 symbol、或人工确认映射中的一个。

### Exposure Conversion

优先使用 delta-adjusted exposure：

```text
stockEquivalentShares = derivativeQuantity * contractMultiplier * delta * positionSide
stockEquivalentNotional = stockEquivalentShares * underlyingPrice
```

方向约定：

- Long Call：`delta > 0`，等效看多正股。
- Long Put：`delta < 0`，等效看空正股或保护已有多头。
- Short Call：等效看空/覆盖卖出风险。
- Short Put：等效看多/接货义务。

如果没有 delta：

- 普通 listed option：用 `quantity * contractMultiplier` 估算 shares，Call 为正，Put 为负，并标记 `exposureConfidence = "estimated"`。
- Warrant / turbo / knock-out：优先用 broker 的 leverage 或 ratio；如果缺失，用 `marketValue * leverage / underlyingPrice` 估算 notional。缺少 leverage 时只记录市值，不参与精确仓位计算。
- PDF-only 衍生品：只生成风险提示，不允许把估算暴露推高到 Tier 1。

### Call Operation Rules

Call 代表看多或杠杆看多，但操作不应该自动等同于“买入正股”：

| Situation | Underlying Action | Option Action |
| --- | --- | --- |
| 正股 Tier 1，Call 未过期且风险可控 | `加仓复核` 或 `建仓评估` | `持有 Call`、`滚动 Call`、或 `转换为正股` |
| 正股 Tier 1，但 Call 临近到期 | `正股替代评估` | `平仓 Call` 或 `roll 到更远 expiry` |
| 正股 Tier 2，Call 盈利较多 | `等待确认` | `止盈部分 Call`，避免时间价值回撤 |
| 正股 Tier 2，Call 亏损且 thesis 未确认 | `不加仓` | `降低杠杆`、`平仓`、或等待触发价 |
| 正股 Tier 3 或 hard blocker | `不建仓` | `平仓 Call` 或 `移入风险复核` |

Call 对正股 tier 的影响：

- 可以提升 Catalyst And Review Urgency，因为期权有 expiry 和杠杆风险。
- 不能单独提升 Conviction；Conviction 仍来自正股基本面、评级和趋势。
- 如果 Call 等效暴露让单票风险超过上限，Portfolio Fit 需要扣分，并可能把“加仓型 Tier 1”改成“减杠杆/转换正股型 Tier 1”。

### Put Operation Rules

Put 需要区分“保护已有正股”和“单独看空”。

| Situation | Underlying Action | Option Action |
| --- | --- | --- |
| 已持有正股，Put 用作保护 | `持有/风险复核` | `保留保护性 Put` 或 `roll hedge` |
| 已持有正股，Put 已深度盈利 | `减仓复核` | `止盈 Put` 或保留部分 hedge |
| 无正股，仅 Long Put | `看空观察` | `限制仓位`、`设置失效条件`、`到期前复核` |
| 正股 Tier 1，但持有 Put | `冲突复核` | 判断 Put 是 hedge 还是 thesis 反转信号 |
| 正股 Tier 3 且 Put thesis 成立 | `不买入正股` | `持有/止盈 Put`，但仍显示高风险 |

Put 对正股 tier 的影响：

- 保护性 Put 不应该直接把正股降级；它应作为 risk control 显示。
- 投机性 Long Put 是负向观点，应该降低 Conviction 或触发 `blockingIssues`。
- Put 盈亏和 expiry 应提高复核紧迫度，尤其是到期 14 天以内。

### Derivative Hard Rules

这些规则在普通 hard rules 之后执行：

- `underlyingMappingConfidence < 0.85`：衍生品最高 Tier 3，不能并入正股暴露。
- 衍生品到期日小于 7 天：正股 action 不能是普通 `加仓评估`，必须变成 `到期处理`、`平仓`、`roll` 或 `转换正股`。
- Knock-out / turbo 缺少 barrier 信息：最高 Tier 3，并标记 `barrier_missing`。
- Long Call / Long Put 的最大损失超过用户设置的衍生品风险预算：不能进入买入型 Tier 1。
- Put 与正股 Tier 1 thesis 冲突时，必须生成 `thesis_conflict`，由用户确认 hedge 目的后才能解除。
- PDF-only 衍生品不能参与精确 stockEquivalent 计算，只能作为风险提示。

### Aggregation Into Underlying Row

同一个正股下可能同时有正股仓位、Call、Put。后端应该聚合成：

- `stockPositionShares`
- `stockPositionValue`
- `derivativeEquivalentShares`
- `netEquivalentShares`
- `grossDerivativeValue`
- `optionDirection`: `bullish` / `bearish` / `hedged` / `mixed`
- `expiryRisk`: `none` / `watch` / `urgent`
- `derivativeActionLabel`

示例：

```json
{
  "symbol": "NVDA",
  "stockPositionShares": 10,
  "derivativeExposure": {
    "optionDirection": "bullish",
    "derivativeEquivalentShares": 5.2,
    "netEquivalentShares": 15.2,
    "expiryRisk": "watch",
    "derivativeActionLabel": "Call 转正股复核",
    "legs": [
      {
        "broker": "trading_republic",
        "instrumentType": "call",
        "side": "long",
        "underlyingSymbol": "NVDA",
        "strike": 150,
        "expiry": "2026-09-18",
        "quantity": 1,
        "contractMultiplier": 10,
        "delta": 0.52,
        "stockEquivalentShares": 5.2,
        "exposureConfidence": "delta_adjusted"
      }
    ]
  }
}
```

### UI Behavior For Options

- 主表仍显示正股 ticker，不把每个 option 产品平铺成独立股票。
- 展开区增加 `Options / Derivatives` 区块，显示 Call/Put、strike、expiry、等效正股、盈亏、风险预算占用。
- 对 Call 显示 `看多杠杆`、`临近到期`、`转正股`、`roll`、`止盈` 等 action chip。
- 对 Put 显示 `保护性 Put`、`看空 Put`、`hedge`、`thesis conflict`、`到期处理` 等 action chip。
- 如果正股 tier 和 option 方向冲突，行内显示 warning chip，而不是静默合并。

## Tier Thresholds

### Tier 1

条件：

- `tierScore >= 75`
- Conviction 不低于 17
- Valuation Gap 不低于 9，或者有明确减仓/止盈/风险控制理由
- Data Quality 不低于 6
- 没有 hard blocker

用途：

- 进入加仓、建仓、减仓或再平衡决策流。
- UI 应展示明确 action，例如 `加仓评估`、`建仓评估`、`止盈复核`。
- 默认 7 天内复核；如果临近财报或价格触发区，缩短到 1-3 天。

### Tier 2

条件：

- `tierScore` 在 55-74 之间；或
- 分数达到 Tier 1，但缺少一个关键确认，例如目标价、外部价格源、催化剂、仓位空间。

用途：

- 重点跟踪，不直接触发交易动作。
- UI action 可以是 `等待估值确认`、`等待价格触发`、`补充研报`、`观察财报`。
- 默认 14-30 天复核；有财报/事件时按事件日期复核。

### Tier 3

条件：

- `tierScore < 55`
- 数据不足、评级偏弱、目标价低于现价、趋势走弱、PDF-only、或存在 hard blocker。

用途：

- 保留在观察池，不进入交易决策。
- UI action 可以是 `仅观察`、`补充数据`、`风险复核`、`移出候选`。
- 默认 30-60 天复核，除非触发价格/新闻/财报条件。

## Hard Rules

这些规则应该在总分之后执行，用来限制最终 tier：

- `rating = 卖出`：最高只能是 Tier 3，除非 row 的 action 明确是减仓/做空/风险控制。
- `targetPrice < price`：最高 Tier 3，除非 action 是止盈、减仓或保护已有利润。
- `fallbackLevel = pdf_only`：最高 Tier 3。
- `priceStaleDays > 7`：最高 Tier 2。
- `priceStaleDays > 30`：最高 Tier 3。
- `identityConfidence < 0.75`：最高 Tier 3。
- `tradable = false`：最高 Tier 3，除非只是研究型观察标的。
- 当前仓位超过用户设置的单票上限：不能作为“加仓型” Tier 1，只能是持有/减仓型 Tier 1 或降到 Tier 2。
- 未映射到正股的 Trading Republic 期权/衍生品：最高 Tier 3。
- 临近到期或 barrier 信息缺失的期权/衍生品：不能进入普通买入型 Tier 1，只能进入风险处理型 action。

## Current Mock Row Interpretation

按当前 mock 数据，可以先这样解释：

| Symbol | Current Tier | Suggested Notes |
| --- | --- | --- |
| NVDA | Tier 1 | 强烈买入、目标价空间约 20%、已有 12.5% 仓位；需要检查是否超过单票上限。 |
| MSFT | Tier 1 | 买入、已有稳定持仓、Trading 212 来源；更偏持有/加仓复核。 |
| ASML | Tier 1 | 买入且目标价空间充足，但当前 `apiStatus = pdf`；如果后端确认是 PDF-only，应降到 Tier 3，除非外部源补全。 |
| AMZN | Tier 2 | 买入且空仓，目标价空间中等；等待建仓价格或组合配置确认。 |
| GOOGL | Tier 2 | 持有评级、已有小仓位；适合继续观察估值和催化剂。 |
| LLY | Tier 2 | 观望且空仓，目标价空间有限；如果仍是 PDF-only，应降到 Tier 3。 |
| TSLA | Tier 3 | 卖出评级且目标价低于现价；只保留风险/做空/减仓观察。 |
| INTC | Tier 3 | 观望、空仓，虽然目标价有空间但 conviction 不足。 |
| NKE | Tier 3 | 持有、小仓位、PDF 来源；需要补外部数据和趋势确认。 |

## Backend DTO Proposal

```json
{
  "id": "isin:US67066G1040",
  "symbol": "NVDA",
  "stockName": "NVIDIA",
  "tier": "tier1",
  "tierScore": 82,
  "tierReason": "强烈买入，目标价空间 19.6%，趋势确认，但当前仓位较高，需要检查单票上限。",
  "actionLabel": "加仓复核",
  "blockingIssues": [],
  "watchTriggers": [
    { "type": "price_below", "value": 136, "label": "回调到 136 以下复核" },
    { "type": "earnings_date", "value": "2026-05-28", "label": "财报后复核" }
  ],
  "derivativeExposure": {
    "optionDirection": "bullish",
    "derivativeEquivalentShares": 5.2,
    "netEquivalentShares": 15.2,
    "expiryRisk": "watch",
    "derivativeActionLabel": "Call 转正股复核",
    "legs": []
  },
  "scoreBreakdown": {
    "conviction": 24,
    "valuationGap": 15,
    "momentumAndTiming": 13,
    "portfolioFit": 14,
    "dataQuality": 9,
    "catalystAndReviewUrgency": 7
  },
  "sources": {
    "priceSource": "alpaca",
    "researchSource": "yfinance",
    "holdingSource": "trading212",
    "fallbackLevel": "none"
  },
  "nextReviewAt": "2026-05-25"
}
```

## UI Behavior

- Tier 表标题可以保留当前文案，但每行展开区应显示 `scoreBreakdown`、`tierReason`、`blockingIssues` 和 `watchTriggers`。
- `API状态` 建议改名为 `数据来源`，显示主价格源或 fallback 状态。
- Tier 1 行应该显示 action chip，例如 `建仓评估`、`加仓复核`、`止盈复核`。
- Tier 2 行应该显示等待条件，例如 `等待价格`、`等待研报`、`等待财报`。
- Tier 3 行应该突出缺失/风险原因，例如 `PDF-only`、`评级偏弱`、`目标价倒挂`。
- 当 hard rule 导致降级时，展开区要展示 `降级原因`，避免用户只看到总分而不理解最终 tier。

## Implementation Plan

1. 在后端 stock-analysis DTO 中加入 tier 相关字段。
2. 实现 `WatchlistScorer`，输入 normalized row，输出 score breakdown、hard-rule caps 和最终 tier。
3. 给评分器写 fixture tests，覆盖目标价倒挂、PDF-only、价格过期、仓位过高、identity ambiguous 等场景。
4. 实现 `DerivativeNormalizer`，把 Trading Republic 期权/衍生品映射为正股 underlying 和 derivative legs。
5. 实现 option exposure 聚合，计算 delta-adjusted 或 estimated 正股等效暴露。
6. 给期权转换写 fixture tests，覆盖 Long Call、Long Put、保护性 Put、未映射 underlying、临近到期、barrier 缺失。
7. 在 `/data/stock-analysis.json` 返回按 `tier` 分组或返回 flat rows 后由前端分组。
8. 前端替换 mock `stockRows`，使用后端 `tier` 字段渲染三张表。
9. 展开区展示评分解释、来源状态、触发条件、期权转换结果和复核日期。
10. 后续接入 LLM 研报时，只允许 LLM 填充 rating、thesis、catalyst、risk，不直接覆盖 hard rules。

## Open Decisions

- 单票仓位上限是多少，例如 8%、10%、15%，需要用户配置。
- Tier 1 是否允许“减仓型 Tier 1”和“买入型 Tier 1”同时存在；建议允许，但 action 必须明确。
- 目标价来源优先级：yfinance analyst target、外部 LLM、用户手动输入之间如何合并。
- 空仓标的是否需要额外的 minimum conviction，例如空仓进入 Tier 1 必须 `Conviction >= 20`。
- 是否需要 Tier 0 / Archive，用于明确移出 watchlist 的标的。
- Trading Republic 期权产品是否都能拿到 delta、multiplier、underlying ISIN；如果拿不到，需要维护多大的人工映射表。
- 用户衍生品风险预算是多少，例如总组合 2%、5% 或按单个 underlying 设置。
- Call 转正股时使用什么触发条件：到期天数、盈利比例、delta、正股 tier，还是用户手动确认。
