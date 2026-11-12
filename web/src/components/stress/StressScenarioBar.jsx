import { useState } from 'react'
import { Box, Button, Chip, Collapse, MenuItem, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import { compactCurrency, number } from '../../utils/formatters.js'
import { PORTFOLIO_STRESS_HORIZONS } from '../../utils/portfolioStress.js'
import { signedPercent } from './shared.jsx'
import CoverageTip from '../shared/CoverageTip.jsx'

const SHOCK_PRESETS = [
  { value: 10, label: '温和', range: '±10%' },
  { value: 20, label: '标准', range: '±20%' },
  { value: 30, label: '偏强', range: '±30%' },
  { value: 50, label: '极端', range: '±50%' },
]

// Shock size and horizon are the everyday controls; everything else sits in
// the advanced settings and shows as a removable chip while it is active.
export default function StressScenarioBar({ settings, onChange, shockTargets, groupShock, coverage, selectedProducts }) {
  const { shock, horizonDays, target, shockMode, ivMove, fxMove } = settings
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const volScaled = shockMode === 'volatility' && !target
  const targetName = shockTargets.find(({ key }) => key === target)?.name
  const active = [
    target ? { key: 'target', label: `只冲击 ${targetName || target}`, reset: { target: '' } } : null,
    volScaled ? { key: 'mode', label: '按波动率缩放', reset: { shockMode: 'uniform' } } : null,
    ivMove ? { key: 'iv', label: `IV ${signedPercent(ivMove)}`, reset: { ivMove: 0 } } : null,
    fxMove ? { key: 'fx', label: `美元 ${signedPercent(fxMove)}`, reset: { fxMove: 0 } } : null,
  ].filter(Boolean)
  const repricedCount = selectedProducts.filter(product => product.scenarioMethods.some(row => /^bs/.test(row.method))).length
  const fxExposedCount = selectedProducts.filter(product => product.fxExposed).length

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <ToggleButtonGroup size="small" exclusive value={shock} onChange={(_event, value) => value != null && onChange({ shock: value })} aria-label="冲击幅度">
          {SHOCK_PRESETS.map(preset => (
            <ToggleButton key={preset.value} value={preset.value} sx={{ px: 1.25, textTransform: 'none' }}>
              {preset.label}<Box component="span" sx={{ ml: 0.5, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{preset.range}</Box>
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <ToggleButtonGroup size="small" exclusive value={horizonDays} onChange={(_event, value) => value != null && onChange({ horizonDays: value })} aria-label="情景期限">
          {PORTFOLIO_STRESS_HORIZONS.map(days => <ToggleButton key={days} value={days} sx={{ px: 1.25 }}>{days === 0 ? '即时' : `${days} 天`}</ToggleButton>)}
        </ToggleButtonGroup>
        <Button size="small" startIcon={<TuneRoundedIcon />} aria-expanded={advancedOpen} aria-controls="stress-advanced-settings" onClick={() => setAdvancedOpen(current => !current)}>
          高级设置
        </Button>
        {active.map(item => <Chip key={item.key} size="small" color="primary" variant="outlined" label={item.label} onDelete={() => onChange(item.reset)} />)}
      </Stack>

      <Collapse in={advancedOpen}>
        <Stack id="stress-advanced-settings" direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', pt: 0.5 }}>
          <TextField select size="small" label="冲击范围" value={target} onChange={event => onChange({ target: event.target.value })} sx={{ minWidth: 150 }}>
            <MenuItem value="">所有标的</MenuItem>
            {shockTargets.map(({ key, name }) => <MenuItem key={key} value={key}>{name}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="各标的幅度" value={volScaled ? 'volatility' : 'uniform'} disabled={Boolean(target)} onChange={event => onChange({ shockMode: event.target.value })} sx={{ minWidth: 140 }}>
            <MenuItem value="uniform">相同幅度</MenuItem>
            <MenuItem value="volatility">按波动率缩放</MenuItem>
          </TextField>
          <TextField select size="small" label="隐含波动率" value={ivMove} onChange={event => onChange({ ivMove: Number(event.target.value) })} sx={{ minWidth: 120 }}>
            {[0, -20, 20].map(value => <MenuItem key={value} value={value}>{value === 0 ? '不变' : `IV ${signedPercent(value)}`}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="美元兑欧元" value={fxMove} onChange={event => onChange({ fxMove: Number(event.target.value) })} sx={{ minWidth: 120 }}>
            {[0, -10, -5, 5, 10].map(value => <MenuItem key={value} value={value}>{value === 0 ? '不变' : `美元 ${signedPercent(value)}`}</MenuItem>)}
          </TextField>
        </Stack>
      </Collapse>

      <Typography variant="caption" color="text.secondary">
        可测本金 {compactCurrency(coverage.coveredValue)}<CoverageTip current="testable" />，占持仓市值 {coverage.coveragePct}%；未覆盖的 {compactCurrency(coverage.outsideValue)} 不视为零风险。
        {horizonDays === 0 ? ' 即时冲击不含时间损耗，价外权证会显得划算，建议用 30 天判断。' : ''}
        {target ? ' 只冲击一个标的时，没有“各标的逆向”情景，也不能请求 Hermes 解读。' : ''}
        {volScaled ? ` 按波动率缩放：±${shock}% 是 IV 处于中位数（${groupShock.referenceVolatilityPct ?? '—'}%）的标的的幅度，其余标的按自身 IV 在 0.4–2.5 倍内缩放${groupShock.unknownCount ? `，${groupShock.unknownCount} 个没有权证 IV 的标的按 ±${shock}%` : ''}。` : ''}
        {ivMove ? ` IV 变化只影响所选方案中按 Black-Scholes 重估的 ${repricedCount} 只权证。` : ''}
        {fxMove ? ` 汇率变化只作用于所选方案中 ${fxExposedCount} 只美元标的产品。` : ''}
        {volScaled && groupShock.groups.length ? ` 各标的幅度：${groupShock.groups.slice(0, 6).map(group => `${group.name} ±${number.format(shock * group.scale)}%`).join('，')}${groupShock.groups.length > 6 ? ' 等' : ''}。` : ''}
      </Typography>
    </Stack>
  )
}
