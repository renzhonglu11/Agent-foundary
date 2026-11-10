import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

async function request(path, options = {}) {
  const response = await fetch(`/api/portfolio-monitor/${path}`, { cache: 'no-store', ...options })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || `监控请求失败 (${response.status})`)
  return body
}

export function useMonitorHistory() {
  return useQuery({ queryKey: ['portfolioMonitorDaily'], queryFn: () => request('daily'), refetchInterval: 60_000 })
}

export function useMonitorEvents(key) {
  return useQuery({ queryKey: ['portfolioMonitorEvents', key], queryFn: () => request(`alerts/${encodeURIComponent(key)}/events`), enabled: Boolean(key) })
}

export function useMonitorActions() {
  const client = useQueryClient()
  const refresh = () => client.invalidateQueries({ queryKey: ['portfolioMonitor'] })
  const save = useMutation({ mutationFn: record => request('settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) }), onSuccess: refresh })
  const acknowledge = useMutation({ mutationFn: key => request(`alerts/${encodeURIComponent(key)}/acknowledge`, { method: 'POST' }), onSuccess: async () => {
    await refresh()
    await client.invalidateQueries({ queryKey: ['portfolioMonitorEvents'] })
  } })
  return { save, acknowledge }
}
