import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from './queryKeys.js'

const EMPTY = []
async function request(path, options) {
  const response = await fetch(`/api/structured-products/${path}`, { cache: 'no-store', ...options })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`)
  return data
}

export function useProductWatchlist() {
  const client = useQueryClient()
  const query = useQuery({ queryKey: queryKeys.productWatchlist, queryFn: () => request('watchlist'), staleTime: 60_000, refetchInterval: 300_000 })
  const save = useMutation({
    mutationFn: isin => request('watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isin }) }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.productWatchlist })
      client.invalidateQueries({ queryKey: queryKeys.ivHistory })
    },
  })
  const remove = useMutation({ mutationFn: isin => request(`watchlist/${encodeURIComponent(isin)}`, { method: 'DELETE' }), onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.productWatchlist }) })
  return { items: query.data?.items ?? EMPTY, loading: query.isPending, error: query.error || save.error || remove.error,
    saving: save.isPending || remove.isPending, save: save.mutate, remove: remove.mutate }
}

export function useProductSearch(filters) {
  return useQuery({
    queryKey: ['productCandidates', filters],
    queryFn: ({ signal }) => request(`candidates?${new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== '' && value != null))}`, { signal }),
    enabled: Boolean(filters), staleTime: 300_000, retry: false,
  })
}
