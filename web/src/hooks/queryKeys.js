export const queryKeys = {
  structuredProducts: ['structuredProducts'],
  structuredProductsRisk: ['structuredProductsRisk'],
  structuredProductsRefreshStatus: ['structuredProductsRefreshStatus'],
  alpacaQuotes: (symbols, cacheOnly = false) => [
    'alpacaQuotes',
    cacheOnly ? 'persisted' : 'live',
    symbols.join(','),
  ],
};
