import { useEffect, useState } from 'react';

export function useHermesCronData({ refreshMs = 60000 } = {}) {
  const [state, setState] = useState({ loading: true, error: null, data: null, refreshedAt: null });

  useEffect(() => {
    let cancelled = false;
    let controller = null;

    const load = () => {
      controller?.abort();
      controller = new AbortController();

      const timestamp = Date.now();
      const url = `/data/hermes-cron-status.json?t=${timestamp}`;

      const fetchJson = async () => {
        const response = await fetch(url, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Data request failed: ${response.status} (${url})`);
        return response.json();
      };

      fetchJson()
        .then((data) => {
          if (!cancelled) setState({ loading: false, error: null, data, refreshedAt: new Date().toISOString() });
        })
        .catch((error) => {
          if (!cancelled && error.name !== 'AbortError') {
            setState((previous) => ({ ...previous, loading: false, error }));
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
