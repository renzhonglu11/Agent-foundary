import { useQuery } from '@tanstack/react-query';
import { queryKeys } from './queryKeys.js';

export async function loadRiskData() {
  const response = await fetch('/api/structured-products-risk', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Risk data request failed: ${response.status}`);
  return response.json();
}

export function useRiskData() {
  const query = useQuery({
    queryKey: queryKeys.structuredProductsRisk,
    queryFn: loadRiskData,
    staleTime: 30_000,
  });

  return {
    loading: query.isPending,
    error: query.error,
    data: query.data ?? null,
    refresh: query.refetch,
  };
}
