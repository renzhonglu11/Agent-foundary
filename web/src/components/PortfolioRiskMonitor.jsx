import { useState } from 'react'
import { Alert, Box, Button, Checkbox, Chip, FormControlLabel, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material'
import { compactCurrency } from '../utils/formatters.js'
import { useMonitorActions, useMonitorEvents, useMonitorHistory } from '../hooks/usePortfolioMonitor.js'

const time = value => value ? new Date(value).toLocaleString() : '—'
const number = value => value == null ? '—' : Number(value).toFixed(2)
const snapshotUrl = key => `/api/portfolio-monitor/snapshots/${encodeURIComponent(key)}`
const statusLabels = { active: '待确认', acknowledged: '已确认 · 风险仍存在', pending: '等待连续命中', resolved: '已恢复 / 持仓已关闭', invalidated: '已失效 · 不能确认恢复' }
const scenarioLabels = { down: '下跌', half_down: '小幅下跌', flat: '横盘', half_up: '小幅上涨', up: '上涨', recovery: '先跌后恢复', roundtrip: '先涨后回落', adverse: '各标的分别逆向' }
const reasonLabels = {
  comparable: '可比较', market_time_unknown: '产品市场时间未知', quote_not_advanced: '产品报价时间未推进', quote_time_mismatch: '产品与标的时间不同步',
  inputs_unavailable: '输入不足或已过期', contract_changed: '合约条款变化', position_closed_or_missing: '持仓已退出或数据缺失',
  expired_without_settlement: '已到期，缺少结算价', intraday_path_unobserved: '缺少日内敲出 / 重置路径', greeks_time_unknown: 'IV 市场时间未知',
  model_version_changed: '计算版本变化', future_market_time: '行情时间异常', target_window_missed: '错过目标观察窗口',
  fx_reference_fallback: '汇率使用备用值', capture_time_unusable: '抓取时间不在收盘附近，或估值来自上传文件',
  recovery_blocked_model_shrank: '损失已回落，但有持仓退出了模型，暂不判定恢复',
  threshold_breached: '达到设置的触发阈值', threshold_recovered: '连续回到恢复阈值以内', position_closed: '对应持仓已关闭', configuration_changed: '监控设置已改变',
  underlying_unusable: '标的报价无效或过期', product_price_missing: '产品报价缺失', unsupported_currency: '币种不支持', valuation_missing: '持仓估值缺失',
  valuation_quantity_mismatch: '数量、单价与估值不一致', underlying_price_missing: '标的价格缺失', unsupported_product: '产品类型暂不支持', direction_missing: '看涨 / 看跌方向不明',
  strike_missing: '行权价缺失', ratio_missing: '兑换比率缺失', expired_or_expiry_missing: '已到期或到期日缺失', volatility_unavailable: '无法取得定价波动率',
  leverage_missing: '杠杆缺失', turbo_terms_missing: 'Turbo 条款不完整', product_data_unusable: '产品输入过期或时间错位', short_or_missing_quantity: '空头或缺少有效数量', fx_missing: '汇率缺失',
}
// Standing limits of the data sources; they do not raise the data-quality alert.
const knownDataLimitations = new Set(['valuation_market_time_unknown', 'greeks_market_time_unknown', 'underlying_unmapped', 'product_currency_unsupported'])
const fields = [
  ['shockPct', '基准冲击幅度 %', 1, 100], ['horizonDays', '情景期限（天）', 0, 90],
  ['ivMovePct', 'IV 相对变化 %', -90, 200], ['fxMovePct', '美元兑欧元变化 %', -90, 100],
]
const limits = [
  ['maxLossEur', '最差情景损失上限 EUR', 0.01, 1e12], ['maxConcentrationPct', '单标的市值占比上限 %', 0, 100],
  ['maxKnockout7dPct', '7 天敲出模型概率上限 %', 0, 100], ['maxDecay7dPct', '横盘 7 天损耗上限 %', 0, 100],
  ['expiryWarningDays', '到期提醒天数', 0, 365], ['minModelCoveragePct', '最低模型覆盖率 %', 0, 100],
]

function SettingsForm({ configuration, save }) {
  const [draft, setDraft] = useState(null)
  if (!configuration) return null
  if (!draft) return <Button size="small" variant="outlined" onClick={() => { save.reset(); setDraft(structuredClone(configuration)) }}>设置后台情景与个人限额</Button>
  return <Box component="form" onSubmit={async event => {
    event.preventDefault()
    try { await save.mutateAsync(draft); setDraft(null) } catch { /* mutation exposes error */ }
  }}>
    <Typography variant="body2" sx={{ mb: 1 }}>留空表示未设置限额；情景参数用于估算，不代表事件概率。修改后后台会重新计算，旧规则预警会标为失效。</Typography>
    <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: 'wrap' }}>
      {[...fields, ...limits].map(([key, label, min, max]) => <TextField key={key} size="small" label={label} type="number" value={draft.settings[key] ?? ''}
        required={fields.some(([name]) => name === key)} slotProps={{ htmlInput: { min, max, step: key === 'horizonDays' ? 1 : 'any' } }}
        onChange={event => setDraft({ ...draft, settings: { ...draft.settings, [key]: event.target.value === '' ? null : Number(event.target.value) } })} sx={{ width: { xs: '100%', sm: 240 } }} />)}
    </Stack>
    <FormControlLabel label="按各标的波动率缩放冲击" control={<Checkbox checked={draft.settings.volatilityScaled} onChange={e => setDraft({ ...draft, settings: { ...draft.settings, volatilityScaled: e.target.checked } })} />} />
    {save.error && <Alert severity="error">{save.error.message}。取消编辑后重新打开，可加载最新设置。</Alert>}
    <Stack direction="row" spacing={1}><Button type="submit" variant="contained" disabled={save.isPending}>保存设置</Button><Button onClick={() => setDraft(null)} disabled={save.isPending}>取消</Button></Stack>
  </Box>
}

export default function PortfolioRiskMonitor({ data }) {
  const { save, acknowledge } = useMonitorActions()
  const history = useMonitorHistory()
  const [eventKey, setEventKey] = useState(null)
  const events = useMonitorEvents(eventKey)
  const risk = data?.snapshot?.risk
  const activeLimits = limits.filter(([key]) => data?.configuration?.settings?.[key] != null)
  const limitedOnly = (data?.snapshot?.positions || []).filter(row => row.issues?.length && row.issues.every(issue => knownDataLimitations.has(issue))).length
  const alerts = [...(data?.alerts || [])].sort((a, b) => ['active', 'acknowledged', 'pending', 'invalidated', 'resolved'].indexOf(a.status) - ['active', 'acknowledged', 'pending', 'invalidated', 'resolved'].indexOf(b.status))
  return <Paper variant="outlined" sx={{ p: 1.5, mt: 1.5, minWidth: 0 }}>
    <Typography variant="subtitle1" fontWeight={700}>后台风险、预警与日终复盘</Typography>
    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>浏览器关闭后仍由后台计算；页面中的手动压力测试与后台保存的情景设置相互独立。</Typography>
    <SettingsForm configuration={data?.configuration} save={save} />
    {!activeLimits.length && <Alert severity="info" sx={{ my: 1 }}>尚未设置个人风险限额；当前只记录数据质量预警，不能据此判断是否符合你的风险承受能力。</Alert>}
    {data?.configuration?.revision !== data?.snapshot?.configuration?.revision && <Alert severity="info" sx={{ my: 1 }}>新设置等待后台下一轮计算；当前结果仍采用快照中的设置。</Alert>}
    {data?.configuration?.settings?.maxLossEur != null && risk?.excluded?.length > 0 && <Alert severity="warning" sx={{ my: 1 }}>组合损失限额只按已建模持仓判定：已覆盖部分的最差损失达到限额就会预警，未覆盖的 {compactCurrency(risk.uncoveredValue)} 不在其中，所以没有预警不代表整个组合通过限额检查。若有持仓因数据缺失退出模型，损失回落也不会判定为恢复。</Alert>}
    {!risk ? <Typography sx={{ my: 1 }}>等待后台首轮情景计算。</Typography> : <>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', my: 1 }}>
        <Chip size="small" label={`模型覆盖 ${number(risk.coveragePct)}% · 全部持仓绝对市值`} />
        <Chip size="small" label={`未覆盖 ${compactCurrency(risk.uncoveredValue)}`} />
        <Chip size="small" color="warning" variant="outlined" label={`已覆盖部分最差盈亏 ${risk.worstPnl == null ? '未知' : compactCurrency(risk.worstPnl)}`} />
      </Stack>
      <Typography variant="caption" component="div">期限 {risk.settings?.horizonDays} 天，基准冲击 ±{risk.settings?.shockPct}%，IV {risk.settings?.ivMovePct}%，美元兑欧元 {risk.settings?.fxMovePct}%。{risk.settings?.volatilityScaled ? '各标的冲击按波动率缩放。' : ''} 未覆盖部分仅保留产品直接跌价压力；现金未知。</Typography>
      <Box component="details" sx={{ my: 1 }}><Box component="summary" sx={{ cursor: 'pointer' }}>情景、损失贡献与未覆盖持仓</Box>
        <Box sx={{ overflowX: 'auto' }}><Table size="small" sx={{ minWidth: 640 }}><TableHead><TableRow><TableCell>情景</TableCell><TableCell>已覆盖部分盈亏</TableCell><TableCell>主要损失贡献</TableCell></TableRow></TableHead><TableBody>
          {(risk.scenarios || []).map(s => <TableRow key={s.id}><TableCell>{scenarioLabels[s.id] || s.id}</TableCell><TableCell>{risk.hasModels ? compactCurrency(s.pnl) : '未知'}</TableCell><TableCell>{[...(s.contributions || [])].filter(c => c.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 3).map(c => `${c.id}: ${compactCurrency(c.pnl)}`).join('；') || '—'}</TableCell></TableRow>)}
        </TableBody></Table></Box>
        {(risk.excluded || []).map(row => <Typography variant="caption" component="div" key={row.id}>{row.name || row.id} · {reasonLabels[row.reason] || row.reason}</Typography>)}
        {(risk.assumptions || []).map(text => <Typography variant="caption" component="div" key={text}>{text}</Typography>)}
      </Box>
    </>}
    <Typography variant="subtitle2" sx={{ mt: 2 }}>应用内预警</Typography>
    <Typography variant="caption">确认只表示已读。普通风险连续两轮命中后触发、连续两轮恢复后解除，并有 15 分钟重新触发冷却；数据失效会单独记录。{limitedOnly > 0 && ` 另有 ${limitedOnly} 个持仓只有数据源的固有限制（估值或 Greeks 没有市场时间、标的未映射、非欧元报价），这类情况不触发数据预警，影响体现在模型覆盖率上。`}</Typography>
    {acknowledge.error && <Alert severity="error">{acknowledge.error.message}</Alert>}
    {!alerts.length && <Typography variant="body2">暂无已触发预警。</Typography>}
    <Box sx={{ overflowX: 'auto', maxHeight: 400 }}><Table size="small" stickyHeader sx={{ minWidth: 640 }}><TableHead><TableRow>{['状态 / 规则', '当前值 / 阈值', '触发 / 确认 / 恢复时间', '记录'].map(s => <TableCell key={s}>{s}</TableCell>)}</TableRow></TableHead><TableBody>
      {alerts.map(alert => <TableRow key={alert.key}>
        <TableCell><Chip size="small" label={statusLabels[alert.status] || alert.status} color={alert.status === 'active' ? 'warning' : 'default'} /><Typography variant="body2">{alert.category === 'data' ? '数据' : '风险'} · {alert.title}</Typography>{alert.partial && <Typography variant="caption" component="div">仅按已建模持仓计算</Typography>}<Typography variant="caption">{reasonLabels[alert.reason] || alert.reason}</Typography></TableCell>
        <TableCell>{number(alert.value)} / {number(alert.threshold)}<Typography variant="caption" component="div">{alert.subject}</Typography></TableCell>
        <TableCell><Typography variant="caption">首次 {time(alert.firstTriggeredAt)}<br />最近 {time(alert.lastTriggeredAt)}<br />确认 {time(alert.acknowledgedAt)}<br />恢复 {time(alert.resolvedAt)}<br />失效 {time(alert.invalidatedAt)}</Typography></TableCell>
        <TableCell>{alert.status === 'active' && <Button size="small" disabled={acknowledge.isPending} onClick={() => acknowledge.mutate(alert.key)}>确认已读</Button>}<Button size="small" onClick={() => setEventKey(eventKey === alert.key ? null : alert.key)}>查看记录</Button>{alert.evidenceKey && <Button size="small" component="a" href={snapshotUrl(alert.evidenceKey)} target="_blank" rel="noreferrer">触发输入</Button>}</TableCell>
      </TableRow>)}
    </TableBody></Table></Box>
    {eventKey && <Box sx={{ my: 1 }}>
      {events.error ? <Alert severity="error">{events.error.message}</Alert> : (events.data || []).map((event, i) => <Typography variant="caption" component="div" key={i}>{{ triggered: '触发', acknowledged: '确认已读', resolved: '恢复', invalidated: '失效' }[event.event] || event.event} · {time(event.happenedAt)} · {reasonLabels[event.state?.reason] || event.state?.reason}{event.state?.evidenceKey && <Button size="small" component="a" href={snapshotUrl(event.state.evidenceKey)} target="_blank" rel="noreferrer">对应快照</Button>}</Typography>)}
    </Box>}
    <Box component="details" sx={{ mt: 2 }}><Box component="summary" sx={{ cursor: 'pointer', fontWeight: 600 }}>日终快照与模型复盘</Box>
      <Typography variant="body2" sx={{ my: 1 }}>每日保存美股收盘至少 15 分钟且产品抓取窗口结束后的首份观察，保存后不覆盖。错过的日期不补造。预测按当时参数冻结；到达期限后，用实际产品价格和标的变化比较。数量变化不计作投资收益。</Typography>
      {history.error && <Alert severity="error">{history.error.message}</Alert>}
      {!history.data?.days?.length && <Typography variant="body2">尚未积累日终快照。首份快照需等待有效收盘窗口；误差比较还需等待预测期限结束。</Typography>}
      {!!history.data?.days?.length && <Box sx={{ overflow: 'auto', maxHeight: 320 }}><Table size="small" stickyHeader sx={{ minWidth: 640 }}><TableHead><TableRow>{['日期 / 完整快照', '模型覆盖', '最差情景盈亏', '日终预警'].map(label => <TableCell key={label}>{label}</TableCell>)}</TableRow></TableHead><TableBody>{history.data.days.map(day => <TableRow key={day.key}><TableCell><Button size="small" component="a" href={snapshotUrl(day.key)} target="_blank" rel="noreferrer">{day.key.slice(4)}</Button></TableCell><TableCell>{number(day.coveragePct)}%</TableCell><TableCell>{day.worstPnl == null ? '未知' : compactCurrency(day.worstPnl)}</TableCell><TableCell>待确认 {day.alertSummary?.active || 0} · 已确认 {day.alertSummary?.acknowledged || 0} · 失效 {day.alertSummary?.invalidated || 0}</TableCell></TableRow>)}</TableBody></Table></Box>}
      {(history.data?.calibrations || []).map(check => <Box component="details" key={check.originKey} sx={{ my: 1 }}><Box component="summary" sx={{ cursor: 'pointer' }}>{check.originKey?.slice(4)} → {check.targetKey?.slice(4)} · 可靠样本 {check.eligibleCount ?? 0} 项{check.eligibleCount > 0 && ` · 平均绝对偏差 ${number(check.meanAbsoluteErrorPct)} 个百分点`} · 参考样本 {check.indicativeCount ?? 0} 项{check.indicativeCount > 0 && ` · 平均绝对偏差 ${number(check.indicativeMeanAbsoluteErrorPct)}、平均偏差 ${number(check.indicativeMeanErrorPct)} 个百分点`}</Box>
        <Typography variant="caption">误差均以起始产品价格为分母。条件重估使用当时冻结的模型与后来实际标的、汇率变化；原始横盘预测的偏差另列。可靠样本要求产品报价带市场时间且与标的同步。参考样本放宽为：报价只有抓取时间但在美股收盘前 2 小时至收盘后 90 分钟内由法兰克福报价取得，或缺少日内敲出 / 重置路径，或 IV 没有市场时间；它们能看出偏差的大小和方向，但包含报价与标的不同步带来的噪声。平均偏差为正表示模型高估了产品价格。{Object.entries(check.indicativeByProductType || {}).map(([type, summary]) => ` ${type}：${summary.count} 项，平均绝对偏差 ${number(summary.meanAbsoluteErrorPct)}、平均偏差 ${number(summary.meanErrorPct)} 个百分点。`).join('')}</Typography>
        <Stack direction="row"><Button size="small" component="a" href={snapshotUrl(check.originKey)} target="_blank" rel="noreferrer">起始快照</Button><Button size="small" component="a" href={snapshotUrl(check.targetKey)} target="_blank" rel="noreferrer">结果快照</Button></Stack>
        {check.reason && <Typography>{reasonLabels[check.reason] || check.reason}</Typography>}
        <Box sx={{ overflowX: 'auto' }}><Table size="small" sx={{ minWidth: 640 }}><TableHead><TableRow>{['产品', '起始 / 实际价格', '冻结横盘预测 / 条件重估', '价格变化与误差', '可比性'].map(s => <TableCell key={s}>{s}</TableCell>)}</TableRow></TableHead><TableBody>
          {(check.rows || []).map(row => <TableRow key={row.id}><TableCell>{row.name || row.id}</TableCell><TableCell>{number(row.originPrice)} / {number(row.actualPrice)}</TableCell><TableCell>{number(row.forecastPrice)} / {number(row.conditionalPrice)}<Typography variant="caption" component="div">预测 {row.forecastHorizonDays} 天；实际间隔 {number(check.elapsedDays)} 天</Typography></TableCell><TableCell>实际 {number(row.actualChangePct)}%<br />横盘预测偏差 {number(row.forecastErrorPct)} pp<br />条件重估偏差 {number(row.modelErrorPct)} pp</TableCell><TableCell>{row.eligible ? '可靠样本' : row.indicative ? '参考样本' : '不计入'} · {(row.reasons?.length ? row.reasons : [row.reason]).map(reason => reasonLabels[reason] || reason).join('、')}{row.quantityChanged && '；持仓数量变化'}{row.scenarioExceeded && '；实际标的变动超出情景范围'}</TableCell></TableRow>)}
        </TableBody></Table></Box>
      </Box>)}
    </Box>
  </Paper>
}
