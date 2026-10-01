# 候选组合选取策略

本文说明压力测试页"候选组合"（稳健 / 均衡 / 高弹性）当前的选取规则，供修改策略的 agent 参考。估值、情景和资金口径见 [portfolio-stress-model.md](portfolio-stress-model.md)。

规则以代码为准；修改 `web/src/strategies/` 时同步更新本文。

## 代码位置

| 文件 | 内容 |
|---|---|
| `web/src/strategies/definitions.js` | 策略定义：id、标题、说明、选取数量 `limit`、打分公式 `score` |
| `web/src/strategies/riskSignals.js` | 风险信号、风险扣分、模型可信度扣分和阈值常量 |
| `web/src/strategies/eligibility.js` | 准入规则 `candidatePolicy`、`candidateEligible`、`eligibleForAnyStrategy` |
| `web/src/strategies/allocation.js` | 等权分配测试本金 `allocateEqualWeight`（含 8% 敞口上限与 selectionFlags） |
| `web/src/strategies/selection.js` | 分散选取 `selectDiversified` |
| `web/src/strategies/index.js` | 统一导出 |
| `web/src/utils/portfolioStress.js` | 编排：`buildProductProfile` 计算收益指标，`buildPortfolioStressReport` 组装候选组合 |
| `web/src/utils/carryCost.js` | Turbo、Factor 持有成本与默认假设 `CARRY_ASSUMPTIONS` |

## 流程

```
Tier 1 产品条目
  → 可计算性过滤（缺报价/数量/标的价/到期参数 → coverage.omitted）
  → buildProductProfile：固定参考情景下的收益指标 + 风险信号 + 风险扣分 + 三种策略分数
  → candidatePolicy：准入（排除 / 仅高弹性 / 全部策略）
  → selectDiversified：按策略分数排序，每个标的取一只，取满 limit
  → allocateEqualWeight：测试本金等权分配给选中产品，受 8% 敞口上限约束，打 selectionFlags
  → aggregatePortfolio：汇总；分不完的本金记为假设现金
```

## 1. 可计算性过滤

产品必须同时满足以下条件才进入测试本金和候选池：

- 有正的产品价格、数量和标的现价。
- 在参考情景（30 天）下所有情景都能算出结果。
- 在 90 天横盘情景下能算出结果。到期在 90 天内的权证需要能计算到期内在价值，否则排除。这样切换时间维度时成员不会变化。

不满足的产品列入 `coverage.omitted`，不算作"候选排除"。

## 2. 参考情景与收益指标

**打分只用固定参考情景，和页面上的冲击幅度、冲击范围、时间维度无关。** 页面控件只改变选中后的重估结果，不改变选了谁、缩仓比例和现金。

- 情景：`PORTFOLIO_STRESS_SCENARIOS`，所有标的同步 −10%、−5%、0%、+5%、+10%
- 时间：30 天。权证计入时间衰减，Turbo、Factor 计入持有成本（见下文），三类产品在同一口径下比较。

每只产品用 `盈亏 / 当前持仓市值` 计算单位收益率，得到：

| 指标 | 含义 |
|---|---|
| `worstReturn` | 五个情景中最低收益率 |
| `bestReturn` | 五个情景中最高收益率 |
| `meanReturn` | 五个情景平均收益率 |
| `flatReturn` | 0% 情景收益率，即 30 天的时间衰减或持有成本 |
| `riskPenalty` | 风险扣分，见第 4 节 |

### Turbo 和 Factor 的持有成本（`carryCost.js`）

只在时间维度 > 0 时计入，即时冲击不计。发行商条款没有数据源，以下参数都是 `CARRY_ASSUMPTIONS` 中的假设值：

| 参数 | 默认值 |
|---|---|
| 参考利率 r（按标的报价币种） | USD 4%，其他按 EUR 2% |
| 融资利差 s | 3% |
| Factor 年费 | 1% |
| 无 IV 时的默认波动率 σ | 50% |

**Turbo（`open_end_turbo`、`knock_out`）**：融资水平按日计息。看涨每年损失 `行权价 × 比率 × (r + s)`，看跌每年获得 `行权价 × 比率 × (r − s)`（`s > r` 时为损失）。缺行权价时用杠杆近似：看涨 `价格 × (L − 1)`，看跌 `价格 × (L + 1)`。开放式 Turbo 的敲出价随融资水平同比例移动，敲出判断使用期末敲出价；`knock_out` 的敲出价固定，计息天数不超过剩余天数。方法后缀 `+financing`。

**Factor（`factor_certificate`）**：在终点冲击价格上乘以

```
exp( ±融资 × 天数/360 − (年费 + ½·β(β−1)·σ²) × 天数/365 )
```

- β 为带方向杠杆：做多 `L`，做空 `−L`。
- 融资：做多付 `(L − 1)(r + s)`，做空得 `(L + 1)(r − s)`。
- σ 依次取：产品自身 IV → 同标的产品 IV 中位数 → 默认 50%。方法后缀分别为 `+carry_iv`、`+carry_group_iv`、`+carry_default_vol`。
- 终点冲击仍按单次跳空（线性 `1 + β × 涨跌幅`），波动损耗代表其余时间标的来回波动的成本。

## 3. 准入规则（`candidatePolicy`）

按顺序判断，命中即返回：

| 顺序 | 条件 | 结果 | `excludedReason` |
|---|---|---|---|
| 1 | `legRiskStatus === 'HARD_BLOCKED'` | 排除 | `hard_blocked` |
| 2 | `isRoll`：`primaryAction === 'ROLL'`，或 0 ≤ 剩余天数 < 7 | 排除，列入 `rollOpportunities` | `roll_current_contract` |
| 3 | `hasUntrustedData`：`exposureConfidence === 'no_data'`，或 `dataCompletenessRiskScore ≥ 6`（缺失按 10） | 排除 | `untrusted_data` |
| 4 | `primaryAction === 'SELL'` 且状态不是 `WATCH` | 排除 | `sell` |
| 5 | 状态是 `WATCH` 且 `isNearBarrier`（障碍距离 < 10%） | 只进高弹性 | — |
| 6 | 其他 | 三种策略都可进 | — |

注意：`SELL` + `WATCH` 不会被第 4 条排除。

## 4. 风险扣分（`productRiskPenalty`）

各项相加：

| 项 | 扣分 |
|---|---|
| 置信度 `exposureConfidence` | `live_delta` 0，`estimated_delta` 0.02，`estimated_omega` 0.04，`estimated_leverage` 0.06，`estimated_market_value` 0.10，`no_data` 0.25，其他 0.12 |
| 数据完整度 | `clamp(dataCompletenessRiskScore / 10, 0, 1) × 0.08` |
| 动作 `primaryAction` | `BUY` 0，`HOLD` 0.02，其他 0.20 |
| 标的组 `groupActionLabel === 'REDUCE_CONCENTRATION'` | 0.08 |
| 状态 `WATCH` | 0.05 |
| 障碍距离 < 10% | 0.10 |
| 敞口占净值 > 8% | 0.08 |
| 模型可信度 `modelQualityPenalty` | 见下表 |

### 模型可信度扣分

按参考情景中每个情景实际使用的计算方法链（`result.method`，以 `+` 分隔）逐项相加，取最差情景的值，记为 `modelPenalty`：

| 方法组件 | 扣分 |
|---|---|
| `delta`、`expiry_intrinsic`、`knockout`、`factor_leverage`、`factor_path`、`theta`、`financing`、`carry_iv` | 0 |
| `carry_group_iv` | 0.02 |
| `omega`、`linear` | 0.03 |
| `carry_default_vol` | 0.05 |
| `intrinsic`、`leverage` | 0.06 |
| `approx` | 0.08 |
| `default_leverage`（缺杠杆数据，按 1 倍兜底） | 0.15 |
| 未知组件 | 0.10 |

`modelPenalty ≥ 0.10` 的产品标记 `MODEL_FALLBACK`。没有这项扣分时，1 倍兜底的产品看起来波动最小，会在稳健策略中被优先选中。

## 5. 策略打分与数量（`definitions.js`）

| 策略 | 公式 | `limit` |
|---|---|---|
| `defensive` 稳健 | `worstReturn + 0.15 × flatReturn − riskPenalty` | 5 |
| `balanced` 均衡 | `meanReturn + 0.45 × worstReturn − riskPenalty` | 8 |
| `elastic` 高弹性 | `bestReturn − 0.25 × abs(worstReturn) − riskPenalty` | 6 |

分数基于单位收益率，不考虑当前仓位大小；候选组合中的仓位大小由第 7 节的资金分配决定。

## 6. 选取（`selectDiversified`）

1. 按该策略分数从高到低排序。
2. 依次选取，每个标的组（`groupKey`）最多一只，选满 `limit` 为止。
3. 如果选出的产品少于 `min(3, limit)` 只，放开每个标的一只的限制，按分数补足。

## 7. 资金分配（`allocateEqualWeight`）

候选组合把测试本金（基准全部可计算产品的市值）等权分配给选中产品：

1. 每只产品有一个最大规模：
   - 敞口上限：`当前市值 × 0.08 / exposureWeightPct`（`exposureWeightPct` 为 Delta 敞口 ÷ 净值，小数形式，由 Python `risk.py` 计算）。
   - 不加仓：状态为 `WATCH`、动作为 `SELL`、或缺少敞口数据的产品，最大规模不超过当前市值。
2. 先按 `测试本金 ÷ 产品数` 平分；最大规模低于这份额度的产品按上限填满，剩余本金再在其他产品间平分，直到分完或所有产品都到上限。
3. 分不完的本金记为假设现金 `cashValue`，收益为 0。
4. 按分配结果同比缩放市值、净值权重和各情景盈亏，记录 `positionScalePct`（大于 100 为模型加仓）。加仓部分按当前价格计入成本，`capitalWeightPct` 按新成本重算。

分配只依赖选中产品和测试本金，切换时间维度或冲击设置不会改变分配结果。

`selectionFlags`：

| 标记 | 条件 | 页面显示 |
|---|---|---|
| `WATCH_PENALIZED` | 状态为 `WATCH` | WATCH 降权 |
| `ELASTIC_ONLY` | 障碍距离 < 10% | 仅高弹性 |
| `EXPOSURE_CAPPED_8_PCT` | 8% 敞口上限限制了规模 | 敞口限至 8% |
| `HELD_AT_CURRENT` | 不加仓规则限制了规模 | 不加仓 |
| `MODEL_FALLBACK` | `modelPenalty ≥ 0.10` | 模型兜底估算 |

## 8. 对比

- `buildPortfolioAdjustments`（`web/src/utils/portfolioComparison.js`）把基准中未选中的产品标为 `exit`，`positionScalePct` 小于 100 的标为 `reduce`，大于 100 的标为 `increase`。这是模型推演，不是交易指令。
- 基准组合 `current`（当前监控基准）包含全部可计算产品，不经过准入、选取和分配。

## 已知局限

- **集中度取决于敞口上限。** 等权起点是测试本金的 1/5–1/8；其他产品触顶时，多出的本金会转给未触顶的产品，单只占比可能更高。单只规模只受 8% 敞口上限约束，而上限依赖 `exposureWeightPct` 的准确性。
- **持有成本是假设值。** 利率、利差和年费没有数据源，用的是统一默认值，不反映具体发行商条款。缺行权价且缺杠杆的 Turbo 不计融资成本。
- **依赖衍生品数据。** 置信度、动作和模型可信度扣分都依赖增强数据（Greeks、杠杆、行权价、到期日）。不联网的刷新（如上传数据后）会合并本地缓存；缓存中没有的产品仍按兜底模型计算并被扣分。
- **选股与页面冲击设置无关。** 冲击范围下拉框只列出当前所选组合中的标的（`buildShockTargets`），所以所选组合一定有该标的敞口；切换到不含该标的的组合时，冲击范围恢复为所有标的。对比表中的其他组合仍可能没有该标的，显示为"无直接敞口"。

## 修改与验证

- 调整权重、公式或数量：改 `definitions.js`。
- 调整阈值或扣分：改 `riskSignals.js`。
- 调整准入：改 `eligibility.js`。新增的 `excludedReason` 需确认页面和 Hermes 载荷是否需要展示。
- 新增 `selectionFlags`：同步 `web/src/components/PortfolioStressTestPanel.jsx` 中的 `selectionFlagLabels`。

- 调整持有成本参数：改 `carryCost.js` 中的 `CARRY_ASSUMPTIONS`，并同步页面方法说明。

- 调整分配方式或不加仓规则：改 `allocation.js`。
- 调整模型可信度扣分：改 `riskSignals.js` 中的 `MODEL_COMPONENT_PENALTIES`。新增方法组件时同步补充扣分。

回归测试在 `web/src/utils/portfolioStress.test.js` 和 `web/src/strategies/allocation.test.js`，覆盖准入、仅高弹性、等权分配与敞口上限、不加仓规则、模型可信度扣分、展期机会、现金守恒和 Turbo/Factor 持有成本。运行：

```bash
npm --prefix web test
npm --prefix web run build
```
