import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'

import { compactCurrency, number } from '../utils/formatters.js'
import { EXIT_LEVEL_META } from '../utils/labels.js'
import { OPPORTUNITY_DEFAULTS } from '../utils/opportunityScreen.js'
import { ROLL_ASSUMPTIONS, ROLL_EXTENSION_DAYS } from '../utils/rollWhatIf.js'
import ProductCandidatesPanel from './ProductCandidatesPanel.jsx'
import { Label, Section } from './shared/Disclosure.jsx'

const toneColors = { positive: 'success', caution: 'warning', neutral: 'default' }
const trendLabels = { up: '上升', down: '下降', mixed: '不明确', unknown: '历史不足' }
const SCREEN_PREVIEW_ROWS = 12
const ROLL_PREVIEW_COUNT = 6

const signed = value => (value == null ? '—' : `${value > 0 ? '+' : ''}${number.format(value)}%`)
const percentage = value => (value == null ? '—' : `${number.format(value)}%`)
const probability = value => (value == null ? '—' : `${number.format(Math.round(value * 100))}%`)

function Line({ children, color = 'text.secondary' }) {
  return <Typography variant="caption" component="div" color={color}>{children}</Typography>
}

const SCREEN_TIPS = {
  tags: '今天满足的规则条件：绿色是有利条件，橙色是需谨慎的条件。阈值见“计算说明与默认阈值”。',
  trend: '收盘价高于 50 日均线且 50 日均线高于 200 日均线为上升，反之为下降。',
  volatility: '隐含波动率（同标的权证 IV 中位数）与 60 日历史波动率之比；没有权证 IV 时显示历史波动率。',
}

function ScreenTable({ rows, minObservations, moreColumns }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 520 }}>
      <Table size="small" stickyHeader aria-label="标的筛选" sx={{ minWidth: moreColumns ? 980 : 720, '& th': { whiteSpace: 'nowrap' }, '& td': { verticalAlign: 'top' } }}>
        <TableHead><TableRow>
          <TableCell>标的</TableCell><TableCell><Label tip={SCREEN_TIPS.tags}>满足的条件</Label></TableCell><TableCell><Label tip={SCREEN_TIPS.trend}>趋势</Label></TableCell>
          {moreColumns ? <TableCell align="right">5 日 / 20 日 / 60 日</TableCell> : null}
          <TableCell align="right">距一年高点</TableCell>
          {moreColumns ? <><TableCell>历史波动率</TableCell><TableCell>隐含波动率</TableCell></> : <TableCell><Label tip={SCREEN_TIPS.volatility}>波动率</Label></TableCell>}
        </TableRow></TableHead>
        <TableBody>{rows.map(row => (
          <TableRow key={row.key} hover>
            <TableCell sx={{ maxWidth: 220 }}>
              <Typography variant="body2" fontWeight={700} noWrap title={row.name}>{row.name}</Typography>
              <Line>{row.symbol} · 仓位 {percentage(row.weightPct)} · {row.productCount} 个持仓</Line>
              {row.watchCount > 0 && <Line>{row.watchCount} 个未持有观察产品</Line>}
              {(row.exitLevel === 'urgent' || row.exitLevel === 'warn') && <Chip size="small" color={EXIT_LEVEL_META[row.exitLevel].color} label={`退场信号：${EXIT_LEVEL_META[row.exitLevel].label}`} sx={{ height: 18, mt: 0.25 }} />}
            </TableCell>
            <TableCell sx={{ minWidth: 220, maxWidth: 320 }}>
              <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                {row.tags.length ? row.tags.map(tag => (
                  <Chip key={tag.code} size="small" color={toneColors[tag.tone]} variant={tag.tone === 'neutral' ? 'outlined' : 'filled'} label={tag.label} sx={{ height: 20 }} />
                )) : <Typography variant="caption" color="text.secondary">无</Typography>}
              </Stack>
            </TableCell>
            <TableCell sx={{ whiteSpace: 'nowrap' }}>
              <Typography variant="body2">{trendLabels[row.trend]}</Typography>
              <Line>较 50 日线 {signed(row.vsSma50Pct)} · 200 日线 {signed(row.vsSma200Pct)}</Line>
            </TableCell>
            {moreColumns ? <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{signed(row.return5dPct)} / {signed(row.return20dPct)} / {signed(row.return60dPct)}</TableCell> : null}
            <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{signed(row.fromHighPct)}</TableCell>
            {!moreColumns ? (
              <TableCell sx={{ whiteSpace: 'nowrap' }}>
                {row.impliedVolatilityPct != null
                  ? <Typography variant="body2">IV {percentage(row.impliedVolatilityPct)}{row.ivToRealized != null ? ` · ${number.format(row.ivToRealized)}×` : ''}</Typography>
                  : <Typography variant="body2">历史 {percentage(row.realizedVolatilityPct)}</Typography>}
                <Line>历史一年分位 {row.volatilityPercentile == null ? '—' : `${row.volatilityPercentile}%`}</Line>
              </TableCell>
            ) : <>
            <TableCell sx={{ whiteSpace: 'nowrap' }}>
              <Typography variant="body2">{percentage(row.realizedVolatilityPct)}</Typography>
              <Line>一年分位 {row.volatilityPercentile == null ? '—' : `${row.volatilityPercentile}%`}</Line>
            </TableCell>
            <TableCell sx={{ whiteSpace: 'nowrap' }}>
              {row.impliedVolatilityPct == null ? <Typography variant="body2" color="text.secondary">无权证 IV</Typography> : <>
                <Typography variant="body2">{percentage(row.impliedVolatilityPct)}{row.ivToRealized != null ? ` · 为历史的 ${number.format(row.ivToRealized)} 倍` : ''}</Typography>
                <Line>{row.ivPercentile != null ? `自身分位 ${row.ivPercentile}%（${row.ivObservations} 天）` : `自身分位：已记录 ${row.ivObservations} 天，需 ${minObservations} 天`}</Line>
              </>}
            </TableCell>
            </>}
          </TableRow>
        ))}</TableBody>
      </Table>
    </TableContainer>
  )
}

function RollBlock({ roll, onSearch }) {
  const rows = [roll.current, ...roll.alternatives]
  return (
    <Paper variant="outlined" sx={{ p: 1.25 }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'baseline' }}>
        <Typography variant="body2" fontWeight={800}>{roll.name}</Typography>
        <Typography variant="caption" color="text.secondary">{roll.groupName} · 标的现价 {number.format(roll.spot)} {roll.currency} · 持仓 {compactCurrency(roll.currentValue)}</Typography>
        <Button size="small" onClick={() => onSearch(roll.id)}>查找真实替代品</Button>
      </Stack>
      {roll.reasons.length > 0 && <Line color="warning.main">{roll.reasons.join('；')}</Line>}
      {!roll.calibrated && <Line>当前报价无法反推波动率，当前合约按提供方 IV 估算，可信度较低。</Line>}
      <TableContainer sx={{ mt: 0.5 }}>
        <Table size="small" aria-label={`${roll.name} 换仓测算`} sx={{ minWidth: 820, '& th': { whiteSpace: 'nowrap' }, '& td': { whiteSpace: 'nowrap' } }}>
          <TableHead><TableRow>
            <TableCell>合约</TableCell><TableCell align="right">行权价（{roll.currency}）</TableCell><TableCell align="right">剩余天数</TableCell>
            <TableCell align="right">价格（EUR）</TableCell><TableCell align="right">杠杆</TableCell><TableCell align="right">保本需标的</TableCell>
            <TableCell align="right">保本概率</TableCell><TableCell align="right">横盘 {ROLL_ASSUMPTIONS.horizonDays} 天</TableCell>
            <TableCell align="right">标的 ±{ROLL_ASSUMPTIONS.shockPct}%（{ROLL_ASSUMPTIONS.horizonDays} 天后）</TableCell>
          </TableRow></TableHead>
          <TableBody>{rows.map(row => (
            <TableRow key={row.id} selected={row.id === 'current'}>
              <TableCell>{row.label}<Line>{row.id === 'current' ? '实际报价' : '理论估值'} · IV {percentage(row.volatilityPct)}</Line></TableCell>
              <TableCell align="right">{number.format(row.strike)}</TableCell>
              <TableCell align="right">{row.days}</TableCell>
              <TableCell align="right">{number.format(row.price)}</TableCell>
              <TableCell align="right">{number.format(row.leverage)}×</TableCell>
              <TableCell align="right">{signed(row.requiredMovePct)}</TableCell>
              <TableCell align="right">{probability(row.breakEvenProbability)}</TableCell>
              <TableCell align="right" sx={{ color: row.flatPct <= -15 ? 'error.main' : undefined }}>{signed(row.flatPct)}</TableCell>
              <TableCell align="right">{signed(row.upPct)} / {signed(row.downPct)}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      </TableContainer>
    </Paper>
  )
}

export default function OpportunitiesPanel({ screen = [], rolls = [], loading, statsError, ivMinObservations = 20, watchlist, entries = [], heldIsins, ivHistory = [] }) {
  const [showAllUnderlyings, setShowAllUnderlyings] = useState(false)
  const [moreColumns, setMoreColumns] = useState(false)
  const [showAllWarrants, setShowAllWarrants] = useState(false)
  const [rollFrom, setRollFrom] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [scrollToken, setScrollToken] = useState(0)
  const searchRef = useRef(null)
  // Opening the search section and scrolling to it happen after it renders.
  useEffect(() => {
    if (scrollToken) searchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [scrollToken])
  const searchRoll = isin => {
    setRollFrom(isin)
    setSearchOpen(true)
    setScrollToken(current => current + 1)
  }
  const flaggedRolls = rolls.filter(roll => roll.flagged)
  const visibleRolls = showAllWarrants ? rolls : flaggedRolls.slice(0, ROLL_PREVIEW_COUNT)
  const visibleScreen = showAllUnderlyings ? screen : screen.slice(0, SCREEN_PREVIEW_ROWS)
  const thresholds = OPPORTUNITY_DEFAULTS
  const positiveCount = screen.filter(row => row.tags.some(tag => tag.tone === 'positive')).length
  const unheldCount = watchlist ? watchlist.items.filter(item => !heldIsins?.has(item.isin)).length : 0

  return (
    <Box sx={{ border: '1px solid #dfe6ee', borderRadius: 2, overflow: 'hidden', backgroundColor: '#fbfdff' }}>
      <Stack spacing={0.5} sx={{ p: { xs: 1.5, md: 2 } }}>
        <Typography variant="subtitle1" fontWeight={900}>机会与换仓</Typography>
        <Typography variant="body2" color="text.secondary">筛出值得研究的标的，并测算把走弱的权证换成更长期限会改变什么。标签只说明今天满足了哪些规则，不是预测，也不是买入建议。</Typography>
      </Stack>
      <Divider />
      <Stack spacing={1.5} sx={{ p: { xs: 1.25, md: 1.75 } }}>
        <Section
          title="换仓参考"
          summary={`${flaggedRolls.length} 只权证的退场信号指向到期、保本概率或时间损耗；共 ${rolls.length} 只权证可测算`}
          defaultExpanded={flaggedRolls.length > 0}
        >
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography variant="caption" color="text.secondary">每只列出三种理论合约作为参考；“查找真实替代品”会查询具体 ISIN 和报价。</Typography>
              {rolls.length > 0 && <FormControlLabel control={<Switch size="small" checked={showAllWarrants} onChange={event => setShowAllWarrants(event.target.checked)} />} label={`显示全部 ${rolls.length} 只`} />}
            </Stack>
            {visibleRolls.length ? <Stack spacing={1} sx={{ maxHeight: 640, overflowY: 'auto' }}>{visibleRolls.map(roll => <RollBlock key={roll.id} roll={roll} onSearch={searchRoll} />)}</Stack>
              : <Typography variant="body2" color="text.secondary">当前没有需要测算换仓的权证。</Typography>}
            {!showAllWarrants && flaggedRolls.length > ROLL_PREVIEW_COUNT && <Line>另有 {flaggedRolls.length - ROLL_PREVIEW_COUNT} 只被标记的权证，打开“显示全部”查看。</Line>}
          </Stack>
        </Section>

        <Section
          title="标的筛选"
          summary={loading ? '读取日线统计…' : `${screen.length} 个标的 · ${positiveCount} 个满足至少一项有利条件`}
          defaultExpanded
        >
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography variant="caption" color="text.secondary">持仓与观察列表中能取得美股日线的标的，按“有利条件数 − 需谨慎条件数”排序；日线请求上限 100 个，持仓优先。</Typography>
              <Stack direction="row" spacing={1}>
                <FormControlLabel control={<Switch size="small" checked={moreColumns} onChange={event => setMoreColumns(event.target.checked)} />} label="更多列" />
                {screen.length > SCREEN_PREVIEW_ROWS && <FormControlLabel control={<Switch size="small" checked={showAllUnderlyings} onChange={event => setShowAllUnderlyings(event.target.checked)} />} label="显示全部" />}
              </Stack>
            </Stack>
            {statsError && <Alert severity="warning" sx={{ py: 0 }}>标的日线统计读取失败，筛选暂不可用。</Alert>}
            {screen.length ? <ScreenTable rows={visibleScreen} minObservations={ivMinObservations} moreColumns={moreColumns} />
              : <Typography variant="body2" color="text.secondary">{loading ? '读取日线统计…' : '没有可筛选的标的。'}</Typography>}
          </Stack>
        </Section>

        {watchlist ? (
          <Box ref={searchRef} sx={{ scrollMarginTop: 80 }}>
            <Section
              title="真实产品搜索与观察列表"
              summary={`${rollFrom ? `正在为 ${rollFrom} 查找替代品 · ` : ''}观察列表 ${unheldCount} 只未持有`}
              expanded={searchOpen}
              onChange={setSearchOpen}
            >
              <ProductCandidatesPanel {...{ watchlist, entries, rolls, heldIsins, rollFrom, ivHistory }} onRollFromChange={setRollFrom} />
            </Section>
          </Box>
        ) : null}

        <Section title="计算说明与默认阈值" summary="标的筛选的条件定义，以及换仓测算的假设">
          <Stack spacing={1.25}>
            <Part title="数据">标的筛选使用 Alpaca IEX 复权日线的收盘价，不使用盘中报价。</Part>
            <Part title="趋势与位置">
              收盘价高于 50 日均线且 50 日均线高于 200 日均线为上升，反之为下降。上升趋势中回调：收盘价和 50 日均线都在 200 日均线之上，收盘价跌破 20 日均线但低于 50 日均线不超过 {thresholds.pullbackMaxBelowSma50Pct}%，且 5 日跌幅达到 {Math.abs(thresholds.pullbackReturn5dPct)}%。接近一年高点：距一年最高价不到 {Math.abs(thresholds.nearHighPct)}%；深度回撤：超过 {Math.abs(thresholds.deepDrawdownPct)}%。
            </Part>
            <Part title="波动率">
              波动率一年分位是当前 20 日历史波动率在过去一年滚动值中的位置，不高于 {thresholds.lowPercentile}% 记为低位，不低于 {thresholds.highPercentile}% 记为高位。隐含波动率取同标的权证 IV 的中位数，与 60 日历史波动率相比，不高于 {number.format(thresholds.cheapIvToRealized)} 倍记为偏低，不低于 {number.format(thresholds.richIvToRealized)} 倍记为偏高。自身分位来自系统每天记录的 IV，至少 {ivMinObservations} 天后才显示；单只权证的 IV 还会随价内外程度和剩余期限漂移，只能粗略参考。
            </Part>
            <Part title="仓位">仓位不低于 {thresholds.concentratedWeightPct}% 记为较集中，低于 {thresholds.lightWeightPct}% 记为较轻。这些阈值是默认值，不是你的个人规则。</Part>
            <Part title="换仓测算">
              三种合约都在原到期日上延长 {ROLL_EXTENSION_DAYS} 天，行权价分别为原行权价、标的现价、价内 10%，比率与当前合约相同。理论价格按 Black-Scholes 计算，波动率取同标的权证 IV 的中位数；当前合约用自己报价反推的波动率。真实产品的报价含发行人点差，不同行权价和期限的波动率也不同，所以理论价格只用于比较合约类型。保本概率是持有到期的口径。杠杆是标的变动 1% 时合约价格的变动百分比。
            </Part>
            <Part title="真实产品">来自 onvista 可检索范围，观察列表独立保存；日线筛选只支持能精确映射到美股代码的标的，其余产品仍保留在观察列表中。</Part>
          </Stack>
        </Section>
      </Stack>
    </Box>
  )
}

function Part({ title, children }) {
  return (
    <Box>
      <Typography variant="body2" fontWeight={800} sx={{ mb: 0.25 }}>{title}</Typography>
      <Typography variant="body2" color="text.secondary" component="div">{children}</Typography>
    </Box>
  )
}
