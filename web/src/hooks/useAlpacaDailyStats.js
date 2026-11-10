import { useQuery } from '@tanstack/react-query'
import { queryKeys } from './queryKeys.js'

async function loadAlpacaDailyStats(symbols) {
  const response = await fetch(`/api/stock-analysis/alpaca-daily-stats?symbols=${encodeURIComponent(symbols.join(','))}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`日线统计请求失败: ${response.status}`)
  return response.json()
}

const EMPTY = []

// Daily history changes once per session and the backend caches it for hours,
// so the page asks rarely.
export function useAlpacaDailyStats(symbols) {
  const normalizedSymbols = [...new Set(symbols.map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean))].sort()
  const query = useQuery({
    queryKey: queryKeys.alpacaDailyStats(normalizedSymbols),
    queryFn: () => loadAlpacaDailyStats(normalizedSymbols),
    enabled: normalizedSymbols.length > 0,
    staleTime: 30 * 60_000,
    refetchInterval: 60 * 60_000,
  })
  return {
    loading: query.isPending && normalizedSymbols.length > 0,
    error: query.error,
    data: normalizedSymbols.length ? (query.data?.stats ?? EMPTY) : EMPTY,
    status: query.data?.status ?? null,
    warnings: query.data?.warnings ?? EMPTY,
  }
}
