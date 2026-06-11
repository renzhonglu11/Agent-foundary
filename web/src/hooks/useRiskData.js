import { useEffect, useState } from 'react';

export function useRiskData() {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let cancelled = false;
    fetch('/data/structured-products-risk.json', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`Risk data request failed: ${response.status}`);
        return response.json();
      })
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

  return state;
}
