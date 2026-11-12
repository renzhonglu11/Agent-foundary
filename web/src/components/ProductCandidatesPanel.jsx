import { useEffect, useMemo, useState } from 'react'
import { Alert, Box, Button, Chip, LinearProgress, Link, MenuItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material'
import { useProductSearch } from '../hooks/useProductCandidates.js'
import { candidateMetrics, compareRealRoll } from '../utils/productCandidates.js'
import { compactCurrency, dateTime, number } from '../utils/formatters.js'

const pct = value => value == null ? '—' : `${value > 0 ? '+' : ''}${number.format(value)}%`
const num = value => value == null ? '—' : number.format(value)
const money = value => value == null ? '—' : compactCurrency(value)
const Line = ({ children }) => <Typography variant="caption" component="div" color="text.secondary">{children}</Typography>

function CandidateTable({ items, watchlist, heldIsins, origin, quantity, ivByIsin }) {
  const saved = new Set(watchlist.items.map(p => p.isin))
  const [sort, setSort] = useState('expiry')
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer) }, [])
  const rows = useMemo(() => items.map(product => {
    const evaluated = candidateMetrics(product, { now })
    const roll = origin ? compareRealRoll(origin, product, quantity, now) : null
    return { product, ...evaluated, roll }
  }).sort((a, b) => {
    if (sort === 'risk') return (b.roll?.comparison?.worstImprovement ?? -Infinity) - (a.roll?.comparison?.worstImprovement ?? -Infinity)
    if (sort === 'decay') return (b.metrics?.flatPct ?? -Infinity) - (a.metrics?.flatPct ?? -Infinity)
    return a.product.expiry.localeCompare(b.product.expiry)
  }), [items, origin, quantity, sort, now])
  return <Box>
    <TextField select size="small" label="本页排序" value={sort} onChange={e => setSort(e.target.value)} sx={{ minWidth: 180, mb: 1 }}>
      <MenuItem value="expiry">到期日</MenuItem><MenuItem value="decay">横盘损耗较低优先</MenuItem>
      {origin && <MenuItem value="risk">最差情景改善较多优先</MenuItem>}
    </TextField>
    <TableContainer sx={{ maxHeight: 540 }}>
      <Table size="small" stickyHeader aria-label={origin ? '真实换仓候选' : '观察产品候选'} sx={{ minWidth: origin ? 1500 : 1000, '& th': { whiteSpace: 'nowrap' }, '& td': { verticalAlign: 'top' } }}>
        <TableHead><TableRow>
          <TableCell>真实产品 / 标的</TableCell><TableCell>条款</TableCell><TableCell>买价 / 卖价</TableCell><TableCell>IV / 自身分位</TableCell>
          <TableCell>保本 / 杠杆</TableCell><TableCell>30 天后：跌 / 横盘 / 涨</TableCell>
          {origin && <><TableCell>等资金换仓</TableCell><TableCell>相对继续持有改善</TableCell></>}
          <TableCell>观察列表</TableCell>
        </TableRow></TableHead>
        <TableBody>{rows.map(({ product: p, metrics: m, issues, roll }) => {
          const history = ivByIsin.get(p.isin)
          const held = heldIsins.has(p.isin)
          return <TableRow key={p.isin} hover>
            <TableCell sx={{ minWidth: 180, maxWidth: 240 }}>
              <Link href={p.sourceUrl} target="_blank" rel="noopener noreferrer">{p.isin}</Link>
              <Line>{p.wkn} · {p.issuer || '发行人未知'}</Line>
              <Typography variant="body2">{p.underlyingName} · {p.optionType === 'put' ? 'Put' : 'Call'}</Typography>
              <Line>{p.underlyingId} · {p.underlyingIsin || '标的 ISIN 未知'}</Line>
              <Chip size="small" variant="outlined" label={held ? '已持有' : '未持有'} sx={{ height: 20, mt: 0.5 }} />
            </TableCell>
            <TableCell sx={{ whiteSpace: 'nowrap' }}>
              {p.expiry}<Line>行权价 {num(p.strikePrice)} {p.underlyingCurrency}</Line><Line>比率 {num(p.ratio)}</Line>
            </TableCell>
            <TableCell sx={{ whiteSpace: 'nowrap' }}>
              {num(p.bid)} / {num(p.ask)} {p.quoteCurrency || '币种未知'}
              <Line>点差 {m ? `${num(m.spreadPct)}%` : '—'}</Line>
              <Line>报价 {dateTime(p.quoteAsOf)}</Line><Line>抓取 {dateTime(p.fetchedAt)}</Line>
            </TableCell>
            <TableCell>
              {p.iv == null ? '—' : `${num(p.iv * 100)}%`}
              <Line>{history?.percentile != null ? `自身分位 ${num(history.percentile)}%` : `已记录 ${history?.observations || 0} 天，需 20 天`}</Line>
              {m && !m.calibrated && <Line>价格模型使用提供方 IV</Line>}
            </TableCell>
            <TableCell sx={{ whiteSpace: 'nowrap' }}>{m ? <>{pct(m.requiredMovePct)}<Line>到期保本概率 {num(m.breakEvenProbability * 100)}%</Line><Line>{num(m.leverage)}×</Line></> : '—'}</TableCell>
            <TableCell sx={{ minWidth: 200, maxWidth: 270 }}>
              {m ? <>{pct(m.downPct)} / {pct(m.flatPct)} / {pct(m.upPct)}<Line>标的 −20% / 不变 / +20%</Line></> : <Typography variant="caption" color="warning.main">{issues.join('；')}</Typography>}
            </TableCell>
            {origin && <>
              <TableCell>{roll?.comparison ? <>{roll.comparison.quantity} 份<Line>买入 {money(roll.comparison.cost)}</Line><Line>剩余现金 {money(roll.comparison.cash)}</Line><Line>新产品点差成本 {money(roll.comparison.spreadCost)}</Line></> : '—'}</TableCell>
              <TableCell sx={{ minWidth: 220, maxWidth: 300 }}>{roll?.comparison ? <>
                最差 {money(roll.comparison.worstImprovement)}<Line>横盘 {money(roll.comparison.flatImprovement)} · 上涨 {money(roll.comparison.upDifference)}</Line>
                <Box component="details"><Typography component="summary" variant="caption" sx={{ cursor: 'pointer' }}>各情景损益：持有 → 换仓</Typography>{roll.comparison.scenarios.map(s => <Line key={s.id}>{({ down: '跌 20%', flat: '横盘', up: '涨 20%' })[s.id]}：{money(s.holdPnl)} → {money(s.rollPnl)}</Line>)}</Box>
              </> : <Typography variant="caption" color="warning.main">{roll?.issues.join('；')}</Typography>}</TableCell>
            </>}
            <TableCell><Stack spacing={0.5}>
              <Button size="small" disabled={watchlist.saving} onClick={() => watchlist.save(p.isin)}>{saved.has(p.isin) ? '刷新报价' : '加入观察'}</Button>
              {saved.has(p.isin) && <Button size="small" color="inherit" disabled={watchlist.saving} onClick={() => watchlist.remove(p.isin)}>移除观察</Button>}
            </Stack></TableCell>
          </TableRow>
        })}</TableBody>
      </Table>
    </TableContainer>
  </Box>
}

export default function ProductCandidatesPanel({ watchlist, entries, rolls, heldIsins, rollFrom, onRollFromChange, ivHistory }) {
  const [query, setQuery] = useState('')
  const [direction, setDirection] = useState('')
  const [minExpiry, setMinExpiry] = useState('')
  const [manualIsin, setManualIsin] = useState('')
  const [filters, setFilters] = useState(null)
  useEffect(() => { setFilters(rollFrom ? { rollFrom, offset: 0 } : null) }, [rollFrom])
  const search = useProductSearch(filters)
  const origin = search.data?.origin
  const quantity = entries.find(entry => entry.item?.symbol === origin?.isin)?.item?.quantity
  const ivByIsin = new Map(ivHistory.map(p => [p.isin, p]))
  const searchMatchesControls = filters && filters.rollFrom === (rollFrom || undefined)
  const submitSearch = e => {
    e.preventDefault()
    const next = { ...(rollFrom ? { rollFrom } : { query: query.trim(), direction }), minExpiry, offset: 0 }
    if (JSON.stringify(next) === JSON.stringify(filters)) search.refetch()
    else setFilters(next)
  }
  return <Stack spacing={1.5}>
    <Box>
      <Typography variant="body2" fontWeight={800}>真实产品搜索与换仓</Typography>
      <Line>从 onvista 搜索普通权证（含多家发行人）；按名称搜索时先匹配一个标的。换仓模式按原产品的精确标的、方向及更晚到期日筛选；券商是否支持交易需自行核对。</Line>
    </Box>
    <Stack component="form" onSubmit={submitSearch} direction="row" useFlexGap spacing={1} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
      <TextField size="small" select label="搜索方式" value={rollFrom} onChange={e => onRollFromChange(e.target.value)} sx={{ minWidth: 220, maxWidth: '100%' }}>
        <MenuItem value="">按标的名称 / ISIN 搜索</MenuItem>{rolls.map(roll => <MenuItem key={roll.id} value={roll.id}>{roll.name} · 换仓</MenuItem>)}
      </TextField>
      {!rollFrom && <><TextField size="small" label="标的名称、代码或产品 ISIN" value={query} onChange={e => setQuery(e.target.value)} slotProps={{ htmlInput: { minLength: 2, maxLength: 80 } }} required />
        <TextField select size="small" label="方向" value={direction} onChange={e => setDirection(e.target.value)} sx={{ minWidth: 100 }}><MenuItem value="">全部</MenuItem><MenuItem value="call">Call</MenuItem><MenuItem value="put">Put</MenuItem></TextField></>}
      <TextField type="date" size="small" label="最早到期日（可选）" value={minExpiry} onChange={e => setMinExpiry(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
      <Button type="submit" variant="outlined" disabled={search.isFetching || (!rollFrom && query.trim().length < 2)}>搜索</Button>
    </Stack>
    {search.isFetching && <LinearProgress />}
    {search.error && <Alert severity="warning">{search.error.message}</Alert>}
    {search.data && searchMatchesControls && <>
      <Line>提供方匹配 {search.data.total} 只；本页显示 {search.data.items.length} 只，排除不符合条款的 {search.data.excludedCount} 只。抓取于 {dateTime(search.data.fetchedAt)}。</Line>
      {origin && <Alert severity="info" sx={{ py: 0 }}>原持仓 {origin.isin} · {origin.underlyingName} · {origin.expiry} 到期。按当前买价卖出 {num(quantity)} 份，所得 {quantity && origin.bid ? money(quantity * origin.bid) : '未知'}，用同一笔资金比较继续持有和换仓。</Alert>}
      {search.data.items.length ? <CandidateTable items={search.data.items} {...{ watchlist, heldIsins, origin, quantity, ivByIsin }} /> : <Typography variant="body2">这一页没有符合条件的普通权证。</Typography>}
      <Stack direction="row" spacing={1}>
        <Button size="small" disabled={!filters.offset || search.isFetching} onClick={() => setFilters({ ...filters, offset: Math.max(0, filters.offset - 30) })}>上一页</Button>
        <Button size="small" disabled={search.data.nextOffset == null || search.isFetching} onClick={() => setFilters({ ...filters, offset: search.data.nextOffset })}>下一页</Button>
      </Stack>
    </>}
    <Box>
      <Typography variant="body2" fontWeight={800}>未持有产品观察列表 · {watchlist.items.filter(p => !heldIsins.has(p.isin)).length} 只未持有</Typography>
      <Line>保存后参与上方标的筛选与 IV 历史积累；不计入持仓市值。后台每 6 小时刷新，手动刷新复用最多 5 分钟缓存。</Line>
    </Box>
    <Stack component="form" direction="row" spacing={1} onSubmit={e => { e.preventDefault(); watchlist.save(manualIsin.trim().toUpperCase()) }}>
      <TextField size="small" label="直接添加产品 ISIN" value={manualIsin} onChange={e => setManualIsin(e.target.value)} slotProps={{ htmlInput: { maxLength: 12 } }} />
      <Button type="submit" disabled={watchlist.saving || manualIsin.trim().length !== 12}>添加</Button>
    </Stack>
    {watchlist.error && <Alert severity="warning">{watchlist.error.message}</Alert>}
    {watchlist.loading ? <LinearProgress /> : watchlist.items.length ? <CandidateTable items={watchlist.items} {...{ watchlist, heldIsins, ivByIsin }} /> : <Line>尚未添加观察产品。可从搜索结果添加，也可输入已知 ISIN。</Line>}
    <Line>模型按 30 天、标的 ±20% 比较；买入使用卖价，未来卖出沿用当前相对点差，数量向下取整并保留现金。未计手续费、税费、交易单位限制和未来点差变化。概率是模型估计；缺少有效输入时不输出估算。</Line>
  </Stack>
}
