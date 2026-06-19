import { useEffect, useState } from 'react'

export async function loadStructuredProducts() {
  const response = await fetch('/data/structured-products-enrichment.json', { cache: 'no-store' })
  if (!response.ok) return []
  const payload = await response.json()
  return Array.isArray(payload?.items) ? payload.items : []
}

export function useStructuredProducts() {
  const [state, setState] = useState({ loading: true, error: null, data: [] })

  useEffect(() => {
    let cancelled = false

    loadStructuredProducts()
      .then((data) => {
        if (!cancelled) setState({ loading: false, error: null, data })
      })
      .catch((error) => {
        if (!cancelled) setState({ loading: false, error, data: [] })
      })

    return () => {
      cancelled = true
    }
  }, [])

  return state
}
