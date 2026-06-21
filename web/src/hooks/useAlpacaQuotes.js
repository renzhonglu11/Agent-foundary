import { useQuery } from '@tanstack/react-query'
import { queryKeys } from './queryKeys.js'

async function loadAlpacaQuotesPayload(symbols, { cacheOnly = false } = {}) {
  const query = symbols.map((symbol) => String(symbol).trim()).filter(Boolean).join(',')
  if (!query) return { quotes: [], cacheTtlSeconds: 60 }

  const cacheParam = cacheOnly ? '&cacheOnly=true' : ''
  const response = await fetch(`/api/stock-analysis/alpaca-quotes?symbols=${encodeURIComponent(query)}${cacheParam}`, { cache: 'no-store' })
  if (!response.ok) return { quotes: [], cacheTtlSeconds: 60 }
  return response.json()
}

export function useAlpacaQuotes(symbols, { cacheOnly = false } = {}) {
  const normalizedSymbols = symbols.map((symbol) => String(symbol).trim()).filter(Boolean)
  const query = useQuery({
    queryKey: queryKeys.alpacaQuotes(normalizedSymbols, cacheOnly),
    queryFn: () => loadAlpacaQuotesPayload(normalizedSymbols, { cacheOnly }),
    enabled: normalizedSymbols.length > 0,
    staleTime: 30_000,
    refetchInterval: (queryState) => {
      const ttlSeconds = Number(queryState.state.data?.cacheTtlSeconds) || 60
      return Math.max(ttlSeconds, 60) * 1000
    },
  })

  return {
    loading: query.isPending && normalizedSymbols.length > 0,
    error: query.error,
    data: normalizedSymbols.length ? (query.data?.quotes ?? []) : [],
    payload: query.data ?? { quotes: [], cacheTtlSeconds: 60 },
    refresh: query.refetch,
  }
}
