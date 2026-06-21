import { useQuery } from '@tanstack/react-query'
import { queryKeys } from './queryKeys.js'

export async function loadStructuredProducts() {
  const response = await fetch('/api/structured-products-enrichment', { cache: 'no-store' })
  if (!response.ok) return []
  const payload = await response.json()
  return Array.isArray(payload?.items) ? payload.items : []
}

export function useStructuredProducts() {
  const query = useQuery({
    queryKey: queryKeys.structuredProducts,
    queryFn: loadStructuredProducts,
    staleTime: 30_000,
  })

  return {
    loading: query.isPending,
    error: query.error,
    data: query.data ?? [],
    refresh: query.refetch,
  }
}
