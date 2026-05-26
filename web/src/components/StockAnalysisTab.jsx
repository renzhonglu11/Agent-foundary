import { useEffect, useMemo, useRef, useState } from 'react'
import { Stack } from '@mui/material'

import RealtimeEnrichmentSnackbar from './stock-analysis/RealtimeEnrichmentSnackbar.jsx'
import StockAnalysisHeader from './stock-analysis/StockAnalysisHeader.jsx'
import WatchlistTable from './stock-analysis/WatchlistTable.jsx'
import { tiers } from './stock-analysis/stockAnalysisUi.js'
import { buildWatchlistGroups, collectTier1AlpacaSymbols } from '../utils/watchlistGrouping.js'

const initialLiveProgress = { percent: 0, current: 0, total: 0, label: 'Starting realtime fetch' }

export default function StockAnalysisTab({ data }) {
  const [search, setSearch] = useState('')
  const [ratingFilter, setRatingFilter] = useState('全部评级')
  const [structuredProducts, setStructuredProducts] = useState([])
  const [alpacaQuotes, setAlpacaQuotes] = useState([])
  const [liveRefreshing, setLiveRefreshing] = useState(false)
  const [liveProgress, setLiveProgress] = useState(initialLiveProgress)
  const mountedRef = useRef(false)
  const progressTimerRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    mountedRef.current = true

    loadStructuredProducts()
      .then((items) => {
        if (!cancelled) setStructuredProducts(items)
      })
      .catch(() => {
        if (!cancelled) setStructuredProducts([])
      })

    fetchRefreshStatus()
      .then((status) => {
        if (cancelled || !status?.running) return
        updateProgressFromStatus(status)
        setLiveRefreshing(true)
        waitForRealtimeRefresh(0)
      })
      .catch(() => {})

    return () => {
      cancelled = true
      mountedRef.current = false
      clearProgressTimer()
    }
  }, [])

  const clearProgressTimer = () => {
    if (progressTimerRef.current) {
      window.clearTimeout(progressTimerRef.current)
      progressTimerRef.current = null
    }
  }

  const updateProgressFromStatus = (status) => {
    setLiveProgress({
      percent: Number(status?.progressPercent) || 0,
      current: Number(status?.progressCurrent) || 0,
      total: Number(status?.progressTotal) || 0,
      label: status?.progressLabel || 'Fetching realtime data',
    })
  }

  const reloadStructuredProducts = async () => {
    const items = await loadStructuredProducts()
    if (!mountedRef.current) return
    setStructuredProducts(items)
  }

  const waitForRealtimeRefresh = (initialDelay = 1500) => {
    clearProgressTimer()
    const startedAt = Date.now()
    const poll = async () => {
      if (!mountedRef.current) return
      const status = await fetchRefreshStatus()
      if (!mountedRef.current) return
      updateProgressFromStatus(status)
      if (!status.running || Date.now() - startedAt > 240000) {
        await reloadStructuredProducts()
        if (!mountedRef.current) return
        setLiveRefreshing(false)
        return
      }
      progressTimerRef.current = window.setTimeout(poll, 3000)
    }
    progressTimerRef.current = window.setTimeout(poll, initialDelay)
  }

  const handleRealtimeRefresh = async () => {
    setLiveRefreshing(true)
    setLiveProgress(initialLiveProgress)
    try {
      const response = await fetch('/api/structured-products-enrichment/refresh', { method: 'POST' })
      if (!response.ok) throw new Error(`Refresh request failed: ${response.status}`)
      waitForRealtimeRefresh()
    } catch {
      setLiveRefreshing(false)
    }
  }

  const stockRowsWithoutAlpaca = useMemo(() => buildWatchlistGroups(data, structuredProducts), [data, structuredProducts])
  const tier1AlpacaSymbols = useMemo(() => collectTier1AlpacaSymbols(stockRowsWithoutAlpaca), [stockRowsWithoutAlpaca])
  const tier1AlpacaSymbolKey = tier1AlpacaSymbols.join(',')

  useEffect(() => {
    let cancelled = false

    if (!tier1AlpacaSymbolKey) {
      setAlpacaQuotes([])
      return () => {
        cancelled = true
      }
    }

    loadAlpacaQuotes(tier1AlpacaSymbols)
      .then((quotes) => {
        if (!cancelled) setAlpacaQuotes(quotes)
      })
      .catch(() => {
        if (!cancelled) setAlpacaQuotes([])
      })

    return () => {
      cancelled = true
    }
  }, [tier1AlpacaSymbolKey])

  const stockRows = useMemo(() => buildWatchlistGroups(data, structuredProducts, alpacaQuotes), [data, structuredProducts, alpacaQuotes])
  const totalRows = Object.values(stockRows).reduce((sum, rows) => sum + rows.length, 0)
  const totalInstruments = Object.values(stockRows).flat().reduce((sum, group) => sum + group.instruments.length, 0)
  const enrichedRows = structuredProducts.length

  return (
    <Stack spacing={2.5}>
      <RealtimeEnrichmentSnackbar open={liveRefreshing} progress={liveProgress} />
      <StockAnalysisHeader
        search={search}
        onSearchChange={setSearch}
        ratingFilter={ratingFilter}
        onRatingFilterChange={setRatingFilter}
        liveRefreshing={liveRefreshing}
        onRealtimeRefresh={handleRealtimeRefresh}
        totalRows={totalRows}
        totalInstruments={totalInstruments}
        enrichedRows={enrichedRows}
      />

      {tiers.map((tier) => (
        <WatchlistTable key={tier.id} tier={tier} rows={stockRows[tier.id]} search={search} ratingFilter={ratingFilter} />
      ))}
    </Stack>
  )
}

async function loadStructuredProducts() {
  const response = await fetch('/data/structured-products-enrichment.json', { cache: 'no-store' })
  if (!response.ok) return []
  const payload = await response.json()
  return Array.isArray(payload?.items) ? payload.items : []
}

async function fetchRefreshStatus() {
  const response = await fetch('/api/structured-products-enrichment/status', { cache: 'no-store' })
  return response.ok ? response.json() : { running: false }
}

async function loadAlpacaQuotes(symbols) {
  const query = symbols.map((symbol) => String(symbol).trim()).filter(Boolean).join(',')
  if (!query) return []
  const response = await fetch(`/api/stock-analysis/alpaca-quotes?symbols=${encodeURIComponent(query)}`, { cache: 'no-store' })
  if (!response.ok) return []
  const payload = await response.json()
  return Array.isArray(payload?.quotes) ? payload.quotes : []
}
