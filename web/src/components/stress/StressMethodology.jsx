import { Alert, Box, Stack, Typography } from '@mui/material'
import { compactCurrency } from '../../utils/formatters.js'

function quoteWindow(entries, field) {
  const dates = entries.map(entry => entry.item?.[field]).filter(value => value && Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(a) - Date.parse(b))
  const unknown = entries.length - dates.length
  return dates.length ? `${new Date(dates[0]).toLocaleString()} — ${new Date(dates.at(-1)).toLocaleString()}；${unknown} 项未知` : '全部未知'
}

function Part({ title, children }) {
  return (
    <Box>
      <Typography variant="body2" fontWeight={800} sx={{ mb: 0.25 }}>{title}</Typography>
      <Typography variant="body2" color="text.secondary" component="div">{children}</Typography>
    </Box>
  )
}

export function StressDataNotes({ coverage, direct, entries, rollOpportunities }) {
  return (
    <Stack spacing={1.25}>
      <Typography variant="caption" color="text.secondary">后台数据是否有故障、缺口，见本页顶部的数据状态标签。</Typography>
      <Alert severity="info">
        可测本金 {compactCurrency(coverage.coveredValue)}（占测试估值 {coverage.coveragePct}%）；测试总市值 {compactCurrency(coverage.accountValue)} 中未覆盖 {compactCurrency(coverage.outsideValue)}，不视为零风险。
        {coverage.omittedCount ? ` ${coverage.omittedCount} 个产品缺少计算字段，估值 ${compactCurrency(coverage.omittedValue)}。` : ''}
        测试仓位按所用报价 × 数量估值；其他仓位沿用汇总报价，债券保留汇总市值，不同来源可能有时间差。
        {coverage.omitted.map(row => <Typography key={row.name} variant="caption" component="div">{row.name}：{row.reason}</Typography>)}
      </Alert>
      <Typography variant="body2">
        全部持仓的报价直接压力（不依赖标的和 Greeks）：
        {direct.map(row => ` 产品价格 ${row.movePct}% → ${compactCurrency(row.pnl)}`).join('；')}。
        这不等于标的同幅下跌，也不是可成交报价。
      </Typography>
      <Typography variant="caption" component="div">
        产品市场时间（缺失表示无法验证新鲜度）：{quoteWindow(entries, 'priceAsOf')}。
        产品抓取 / 导入时间：{quoteWindow(entries, 'priceFetchedAt')}。
        标的时间：{quoteWindow(entries, 'underlyingPriceAsOf')}。
      </Typography>
      {rollOpportunities?.length ? (
        <Alert severity="warning" sx={{ py: 0 }}>
          {rollOpportunities.length} 个持仓将在 7 天内到期或已标记为 ROLL：{rollOpportunities.map(row => row.name).join('、')}。方案只模拟卖出，不模拟换入远期合约。
        </Alert>
      ) : null}
    </Stack>
  )
}

// The former single methodology paragraph, split by topic.
export function StressMethodology() {
  return (
    <Stack spacing={1.5}>
      <Part title="方案与本金">
        对比方案都是在当前持仓上减仓或退出，卖出所得记为零收益现金，不买入其他产品，忽略交易费用、买卖价差和税。各方案使用同一笔可测本金，未覆盖仓位保持不变。仓位大小按线性缩放。冲击测试只衡量既定持仓的影响，不代表预期收益或盈利概率。
      </Part>
      <Part title="情景">
        五个终点情景为 −M、−M/2、0、+M/2、+M。期限大于 0 时增加两条两步路径（先跌后恢复、先涨后回落），假设连续两个重置周期发生冲击、随后持平，只有 Factor 和敲出检查使用中间路径，权证仍按终点近似。“各标的逆向”让每个标的各自取对组合最不利的终点涨跌，是不考虑相关性的上限估计。按波动率缩放用各标的权证 IV 的中位数相对全部标的中位数的比值调整幅度。汇率冲击只作用于美元标的产品，按到期支付以新汇率折算。长期情景仍是假设末期单次冲击。即时冲击不含时间损耗，期权的凸性会让价外权证显得划算。
      </Part>
      <Part title="排序指标">
        保护效率 = 最差情景亏损的减少额 ÷ 最大上涨情景盈利的减少额，只反映所选情景下的取舍。在同步下跌情景中盈利的仓位标为对冲仓位，不参与效率排序。风险密度 = 最差情景改善 ÷ 释放现金。
      </Part>
      <Part title="权证定价">
        到期晚于测试期限的权证用 Black-Scholes 完整重估：波动率由当前报价反推，再按情景后的标的价格、剩余期限和 IV 变化重新定价，已包含时间价值损耗。报价无法反推，或反推结果与提供方 IV 相差一倍以上（多见于深度价内、报价与标的不同步）时改用提供方 IV；两者都缺才退回 Delta / Omega 线性近似。重估假设欧式行权、无股息、情景前后波动率不随标的涨跌自动变化。
      </Part>
      <Part title="Turbo 与 Factor">
        Turbo 按假设融资利率（美元 4%、欧元 2% 参考利率 ± 3% 利差）逐日调整融资水平，开放式敲出价随之移动。Factor 计入融资、1% 年费和波动损耗，波动率优先取同标的权证 IV，缺失按 50%。敲出按保守零回收处理。
      </Part>
      <Part title="没有模拟的部分">
        具体敲出残值、日内重置、发行人实际融资条款、发行人信用、买卖价差，以及美元以外的汇率变化。
      </Part>
    </Stack>
  )
}
