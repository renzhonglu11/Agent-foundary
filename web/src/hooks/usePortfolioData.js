import { useQuery } from '@tanstack/react-query';
import { queryKeys } from './queryKeys.js';

export async function fetchPortfolioData() {
  const response = await fetch('/data/portfolio-summary.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Data request failed: ${response.status}`);
  return response.json();
}

export function usePortfolioData() {
  const query = useQuery({
    queryKey: queryKeys.portfolio,
    queryFn: fetchPortfolioData,
  });

  return {
    loading: query.isPending,
    error: query.error,
    data: query.data ?? null,
    refresh: query.refetch,
  };
}
