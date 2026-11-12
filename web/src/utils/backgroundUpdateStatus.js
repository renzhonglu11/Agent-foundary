export const MONITOR_STALE_MS = 180_000

export function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

// Time of the last completed background check, in milliseconds. A check that
// finds every input unchanged keeps the stored snapshot, so the snapshot's own
// time may be older than the check.
export function lastMonitorCheck(data) {
  const times = [data?.snapshot?.evaluatedAt, data?.runtime?.lastCheckedAt].filter(validTimestamp).map(Date.parse)
  return times.length ? Math.max(...times) : null
}

export function monitorUpdateState(data, error, now = Date.now()) {
  if (error) return { label: '状态不可用', color: 'error', issue: '无法读取后台监控状态，不能确认是否仍在更新。' }
  if (!data) return { label: '读取中', color: 'default' }
  if (data.enabled === false) return { label: '已关闭', color: 'warning', issue: '后台标的报价与风险监控已关闭。' }
  if (data.enabled !== true) return { label: '状态未知', color: 'warning', issue: '后台未返回监控启用状态。' }
  if (data.runtime?.lastError) return { label: '检查失败', color: 'error', issue: data.runtime.lastError }
  const at = data.snapshot?.evaluatedAt
  if (data.snapshot && (!validTimestamp(at) || Date.parse(at) > now + 120_000)) {
    return { label: '时间异常', color: 'warning', issue: '后台快照的检查时间缺失或异常。' }
  }
  if (validTimestamp(at) && now - lastMonitorCheck(data) > MONITOR_STALE_MS) {
    return { label: '检查超时', color: 'warning', issue: '后台超过 3 分钟未完成检查，当前展示的是旧数据。' }
  }
  if (!data.snapshot && validTimestamp(data.runtime?.lastStartedAt) && now - Date.parse(data.runtime.lastStartedAt) > MONITOR_STALE_MS) {
    return { label: '首轮检查超时', color: 'warning', issue: '后台首轮检查已超过 3 分钟，尚未生成快照。' }
  }
  if (data.snapshot?.provider?.failed || data.snapshot?.historyWarnings?.length) {
    return { label: '更新受限', color: 'warning', issue: '标的报价或日线更新存在失败或缺失，部分指标正在使用缓存或等待补全。' }
  }
  if (data.runtime?.running) return { label: '正在检查', color: 'info', busy: true }
  if (!data.snapshot) return { label: '等待首轮', color: 'default' }
  return { label: '运行正常', color: 'success' }
}

export function productUpdateState(data, error, marketOpen) {
  if (error) return { label: '状态不可用', color: 'error', issue: '无法读取产品抓取状态，不能确认刷新进度。' }
  if (!data) return { label: '读取中', color: 'default' }
  if (data.lastError) return { label: '抓取失败', color: 'error', issue: data.lastError }
  if (data.providerStatusError) return { label: '渠道状态未知', color: 'warning', issue: data.providerStatusError }
  if (Array.isArray(data.providers) && data.providers.some(provider => provider.coolingDown && (provider.scope === 'products' || ['api.onvista.de', 'api.boerse-frankfurt.de'].includes(provider.source)))) {
    return { label: '渠道冷却中', color: 'warning', busy: Boolean(data.running), issue: '部分数据源暂时暂停请求；可用渠道继续更新，缺失部分保留缓存。' }
  }
  if (Array.isArray(data.providers) && data.providers.some(provider => provider.budget?.limited && provider.scope === 'products')) {
    return { label: '请求预算已用完', color: 'warning', busy: Boolean(data.running), issue: '部分产品来源达到本地请求预算，额度恢复后由后续任务重试；已有缓存继续保留。' }
  }
  if (data.running) return { label: data.mode === 'fallback' ? '整理缓存中' : '正在抓取', color: 'info', busy: true }
  if (data.queued) return { label: '排队中', color: 'info', busy: true }
  if (data.liveEnabled === false) return { label: '实时抓取关闭', color: 'warning', issue: '产品实时抓取已关闭，已有缓存仍可显示。' }
  if (data.autoRefreshActive === false) return { label: '自动刷新未运行', color: 'warning', issue: '产品自动刷新调度未运行。' }
  if (data.liveEnabled !== true || data.autoRefreshActive !== true) return { label: '状态未知', color: 'warning', issue: '产品抓取状态信息不完整。' }
  if (marketOpen === false) return { label: '休市等待', color: 'success' }
  if (marketOpen === true) return { label: '等待下轮', color: 'success' }
  return { label: '调度已启用', color: 'success' }
}

export function providerUpdateState(data, error) {
  if (error || data?.providerStatusError) return { label: '状态不可用', color: 'warning', issue: data?.providerStatusError || '无法读取数据源访问保护状态。' }
  if (!Array.isArray(data?.providers) || !data.providers.length) return { label: '暂无请求记录', color: 'default' }
  if (data.providers.some(provider => provider.coolingDown)) return { label: '部分来源暂停', color: 'warning', issue: '部分数据源处于冷却期；等待结束后由后续任务重试，已有缓存继续保留。' }
  if (data.providers.some(provider => provider.budget?.limited)) return { label: '部分来源预算用完', color: 'warning', issue: '已达到本地请求上限；这不代表数据源封禁。滚动额度恢复后再尝试。' }
  if (data.providers.some(provider => provider.budget?.backgroundLimited)) return { label: '后台请求受限', color: 'warning', issue: '后台请求额度已用完，剩余额度保留给 Tier 1 持仓更新。' }
  return { label: '未在冷却', color: 'success' }
}

export function providerAccessLabel(provider) {
  if (provider.coolingDown) return '暂停请求'
  if (provider.budget?.limited) return '请求预算已用完'
  if (provider.budget?.backgroundLimited) return '后台额度用完，Tier 1 可继续'
  return provider.lastStatus >= 200 && provider.lastStatus < 300 ? '最近请求成功' : '等待下次尝试'
}

export function backgroundUpdateState(monitor, products, providers) {
  const states = [monitor, products, providers].filter(Boolean)
  if (states.some(row => row.color === 'error')) {
    return { label: '更新异常', color: 'error' }
  }
  if (states.some(row => row.color === 'warning')) {
    return { label: '需关注', color: 'warning' }
  }
  if (states.some(row => row.busy)) return { label: '更新中', color: 'info', busy: true }
  if (states.some(row => row.color === 'default')) return { label: '准备中', color: 'default' }
  return { label: '运行正常', color: 'success' }
}
