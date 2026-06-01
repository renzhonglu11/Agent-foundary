import { useEffect, useState, useCallback } from 'react';

export function useMacroAnalysis({ refreshMs = 0 } = {}) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    data: null,
    refreshedAt: null,
  });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback((isManual = false) => {
    setState((previous) => ({ ...previous, loading: !isManual }));

    const timestamp = Date.now();
    const url = `/data/macro-analysis.json?t=${timestamp}`;

    return fetch(url, {
      cache: 'no-store',
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load macro economic analysis: ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        setState({
          loading: false,
          error: null,
          data,
          refreshedAt: new Date().toISOString(),
        });
      })
      .catch((error) => {
        setState({
          loading: false,
          error,
          data: null,
          refreshedAt: null,
        });
      });
  }, []);

  const triggerRefresh = useCallback(() => {
    setRefreshing(true);
    const url = `/api/macro-analysis/refresh`;

    return fetch(url, {
      method: 'POST',
      cache: 'no-store',
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Manual refresh trigger failed: ${response.status}`);
        }
        return response.json();
      })
      .then(() => {
        // Wait a short duration (e.g. 1.5 seconds) then poll for the new data
        setTimeout(() => {
          load(true).finally(() => setRefreshing(false));
        }, 1500);
      })
      .catch((error) => {
        console.error('Failed to trigger macro analysis refresh:', error);
        setRefreshing(false);
      });
  }, [load]);

  useEffect(() => {
    let cancelled = false;

    if (!cancelled) {
      load();
    }

    const timer = refreshMs > 0 ? window.setInterval(() => load(), refreshMs) : null;

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [load, refreshMs]);

  return {
    ...state,
    refresh: triggerRefresh,
    refreshing,
  };
}
