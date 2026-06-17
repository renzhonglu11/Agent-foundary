import { useEffect, useState } from 'react';

export async function loadRiskData() {
  const response = await fetch('/data/structured-products-risk.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Risk data request failed: ${response.status}`);
  return response.json();
}

export function useRiskData() {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  const refresh = () => loadRiskData()
    .then((data) => {
      setState({ loading: false, error: null, data });
      return data;
    })
    .catch((error) => {
      setState({ loading: false, error, data: null });
      throw error;
    });

  useEffect(() => {
    let cancelled = false;
    loadRiskData()
      .then((data) => {
        if (!cancelled) setState({ loading: false, error: null, data });
      })
      .catch((error) => {
        if (!cancelled) setState({ loading: false, error, data: null });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { ...state, refresh };
}
