export const queryKeys = {
  portfolio: ['portfolio'],
  structuredProducts: ['structuredProducts'],
  structuredProductsRisk: ['structuredProductsRisk'],
  structuredProductsRefreshStatus: ['structuredProductsRefreshStatus'],
  alpacaQuotes: (symbols, cacheOnly = false) => [
    'alpacaQuotes',
    cacheOnly ? 'persisted' : 'live',
    symbols.join(','),
  ],
  alpacaDailyStats: (symbols) => ['alpacaDailyStats', symbols.join(',')],
  ivHistory: ['ivHistory'],
  productWatchlist: ['productWatchlist'],
};
