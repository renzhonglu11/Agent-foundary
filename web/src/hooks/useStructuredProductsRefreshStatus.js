import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from './queryKeys.js'

export async function fetchStructuredProductsRefreshStatus() {
  const response = await fetch('/api/structured-products-enrichment/status', { cache: 'no-store' })
  return response.ok ? response.json() : { running: false }
}

export function useStructuredProductsRefreshStatus() {
  return useQuery({
    queryKey: queryKeys.structuredProductsRefreshStatus,
    queryFn: fetchStructuredProductsRefreshStatus,
    refetchInterval: (query) => (query.state.data?.running ? 3_000 : 30_000),
    refetchIntervalInBackground: true,
  })
}

export function useStructuredProductsDataSync() {
  const queryClient = useQueryClient()
  const initializedRef = useRef(false)
  const lastFinishedAtRef = useRef(null)
  const statusQuery = useStructuredProductsRefreshStatus()
  const lastFinishedAt = statusQuery.data?.lastFinishedAt || null

  useEffect(() => {
    if (!statusQuery.data) return

    if (initializedRef.current && lastFinishedAtRef.current !== lastFinishedAt) {
      queryClient.invalidateQueries({ queryKey: queryKeys.structuredProducts })
      queryClient.invalidateQueries({ queryKey: queryKeys.structuredProductsRisk })
      queryClient.invalidateQueries({ queryKey: ['alpacaQuotes'] })
    }

    initializedRef.current = true
    lastFinishedAtRef.current = lastFinishedAt
  }, [lastFinishedAt, queryClient, statusQuery.data])

  return statusQuery
}
