import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Stack } from '@mui/material'

import RealtimeEnrichmentSnackbar from './stock-analysis/RealtimeEnrichmentSnackbar.jsx'
import StockAnalysisHeader from './stock-analysis/StockAnalysisHeader.jsx'
import WatchlistTable from './stock-analysis/WatchlistTable.jsx'
import { tiers } from './stock-analysis/stockAnalysisUi.js'
import { buildWatchlistGroups, collectTier1MonitoringAlpacaSymbols } from '../utils/watchlistGrouping.js'
import { useRiskData } from '../hooks/useRiskData.js'
import { useStructuredProducts } from '../hooks/useStructuredProducts.js'
import { useAlpacaQuotes } from '../hooks/useAlpacaQuotes.js'
import { useStructuredProductsRefreshStatus } from '../hooks/useStructuredProductsRefreshStatus.js'
import { queryKeys } from '../hooks/queryKeys.js'

const initialLiveProgress = { percent: 0, current: 0, total: 0, label: 'Starting realtime fetch' }

export default function StockAnalysisTab({ data }) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [ratingFilter, setRatingFilter] = useState('全部评级')
  const [liveRefreshing, setLiveRefreshing] = useState(false)
  const [liveProgress, setLiveProgress] = useState(initialLiveProgress)
  const { data: structuredProducts } = useStructuredProducts()
  const { data: riskData } = useRiskData()
  const refreshStatusQuery = useStructuredProductsRefreshStatus()
  const refreshStatus = refreshStatusQuery.data

  useEffect(() => {
    if (!refreshStatus) return
    setLiveProgress({
      percent: Number(refreshStatus?.progressPercent) || 0,
      current: Number(refreshStatus?.progressCurrent) || 0,
      total: Number(refreshStatus?.progressTotal) || 0,
      label: refreshStatus?.progressLabel || 'Fetching realtime data',
    })
    if (refreshStatus.running) {
      setLiveRefreshing(true)
    } else if (liveRefreshing) {
      setLiveRefreshing(false)
    }
  }, [liveRefreshing, refreshStatus])

  const handleRealtimeRefresh = async () => {
    setLiveRefreshing(true)
    setLiveProgress(initialLiveProgress)
    try {
      const response = await fetch('/api/structured-products-enrichment/refresh', { method: 'POST' })
      if (!response.ok) throw new Error(`Refresh request failed: ${response.status}`)
      queryClient.invalidateQueries({ queryKey: queryKeys.structuredProductsRefreshStatus })
    } catch {
      setLiveRefreshing(false)
    }
  }

  const stockRowsWithoutAlpaca = useMemo(() => buildWatchlistGroups(data, structuredProducts), [data, structuredProducts])
  const tier1AlpacaSymbols = useMemo(() => collectTier1MonitoringAlpacaSymbols(stockRowsWithoutAlpaca), [stockRowsWithoutAlpaca])
  const { data: alpacaQuotes } = useAlpacaQuotes(tier1AlpacaSymbols)

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
        <WatchlistTable key={tier.id} tier={tier} rows={stockRows[tier.id]} search={search} ratingFilter={ratingFilter} riskData={riskData} />
      ))}
    </Stack>
  )
}
