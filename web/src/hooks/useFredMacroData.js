import { useEffect, useState } from 'react';

export function useFredMacroData({ refreshMs = 0 } = {}) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    data: null,
    refreshedAt: null,
  });

  useEffect(() => {
    let cancelled = false;
    let controller = null;

    const load = () => {
      controller?.abort();
      controller = new AbortController();

      setState((previous) => ({ ...previous, loading: true }));

      const timestamp = Date.now();
      const url = `/api/fred/macro-data?t=${timestamp}`;

      fetch(url, {
        cache: 'no-store',
        signal: controller.signal,
      })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`FRED Macro API failed: ${response.status}`);
          }
          return response.json();
        })
        .then((data) => {
          if (!cancelled) {
            setState({
              loading: false,
              error: null,
              data,
              refreshedAt: new Date().toISOString(),
            });
          }
        })
        .catch((error) => {
          if (!cancelled && error.name !== 'AbortError') {
            setState({
              loading: false,
              error,
              data: null,
              refreshedAt: null,
            });
          }
        });
    };

    load();

    const timer = refreshMs > 0 ? window.setInterval(load, refreshMs) : null;

    return () => {
      cancelled = true;
      controller?.abort();
      if (timer) window.clearInterval(timer);
    };
  }, [refreshMs]);

  return state;
}
