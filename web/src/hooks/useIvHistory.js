import { useQuery } from '@tanstack/react-query'
import { queryKeys } from './queryKeys.js'

const EMPTY = []

async function loadIvHistory() {
  const response = await fetch('/api/structured-products/iv-history', { cache: 'no-store' })
  if (!response.ok) throw new Error(`IV 历史请求失败: ${response.status}`)
  return response.json()
}

// One observation is added per product and day, so an hourly read is plenty.
export function useIvHistory() {
  const query = useQuery({
    queryKey: queryKeys.ivHistory,
    queryFn: loadIvHistory,
    staleTime: 30 * 60_000,
    refetchInterval: 60 * 60_000,
  })
  return {
    loading: query.isPending,
    error: query.error,
    data: query.data?.items ?? EMPTY,
    minObservations: query.data?.minObservationsForPercentile ?? 20,
  }
}
