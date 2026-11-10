export const MONITOR_STALE_MS = 180_000

export function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
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
  if (validTimestamp(at) && now - Date.parse(at) > MONITOR_STALE_MS) {
    return { label: '检查超时', color: 'warning', issue: '后台超过 3 分钟未生成新快照，当前展示的是旧数据。' }
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
  if (data.running) return { label: data.mode === 'fallback' ? '整理缓存中' : '正在抓取', color: 'info', busy: true }
  if (data.queued) return { label: '排队中', color: 'info', busy: true }
  if (data.liveEnabled === false) return { label: '实时抓取关闭', color: 'warning', issue: '产品实时抓取已关闭，已有缓存仍可显示。' }
  if (data.autoRefreshActive === false) return { label: '自动刷新未运行', color: 'warning', issue: '产品自动刷新调度未运行。' }
  if (data.liveEnabled !== true || data.autoRefreshActive !== true) return { label: '状态未知', color: 'warning', issue: '产品抓取状态信息不完整。' }
  if (marketOpen === false) return { label: '休市等待', color: 'success' }
  if (marketOpen === true) return { label: '等待下轮', color: 'success' }
  return { label: '调度已启用', color: 'success' }
}

export function backgroundUpdateState(monitor, products) {
  if ([monitor, products].some(row => row.color === 'error')) {
    return { label: '更新异常', color: 'error' }
  }
  if ([monitor, products].some(row => row.color === 'warning')) {
    return { label: '需关注', color: 'warning' }
  }
  if ([monitor, products].some(row => row.busy)) return { label: '更新中', color: 'info', busy: true }
  if ([monitor, products].some(row => row.color === 'default')) return { label: '准备中', color: 'default' }
  return { label: '运行正常', color: 'success' }
}
