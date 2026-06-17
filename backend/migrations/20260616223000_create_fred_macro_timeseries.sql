CREATE TABLE IF NOT EXISTS fred_macro_cache_runs (
    cache_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    cache_ttl_seconds INTEGER NOT NULL,
    warnings_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS fred_series (
    cache_key TEXT NOT NULL,
    series_id TEXT NOT NULL,
    title TEXT NOT NULL,
    units TEXT NOT NULL,
    frequency TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (cache_key, series_id),
    FOREIGN KEY (cache_key) REFERENCES fred_macro_cache_runs(cache_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fred_observations (
    cache_key TEXT NOT NULL,
    series_id TEXT NOT NULL,
    observation_date TEXT NOT NULL,
    value REAL NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (cache_key, series_id, observation_date),
    FOREIGN KEY (cache_key, series_id) REFERENCES fred_series(cache_key, series_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fred_observations_series_date
ON fred_observations(series_id, observation_date);

INSERT OR REPLACE INTO fred_macro_cache_runs (
    cache_key,
    provider,
    status,
    generated_at,
    fetched_at,
    cache_ttl_seconds,
    warnings_json
)
SELECT
    cache_key,
    COALESCE(json_extract(payload_json, '$.provider'), 'fred'),
    status,
    COALESCE(json_extract(payload_json, '$.generatedAt'), fetched_at),
    fetched_at,
    COALESCE(CAST(json_extract(payload_json, '$.cacheTtlSeconds') AS INTEGER), 0),
    COALESCE(json_extract(payload_json, '$.warnings'), '[]')
FROM fred_macro_data_cache
WHERE json_valid(payload_json);

INSERT OR REPLACE INTO fred_series (
    cache_key,
    series_id,
    title,
    units,
    frequency,
    sort_order,
    updated_at
)
SELECT
    cache.cache_key,
    json_extract(series.value, '$.id'),
    COALESCE(json_extract(series.value, '$.title'), ''),
    COALESCE(json_extract(series.value, '$.units'), ''),
    COALESCE(json_extract(series.value, '$.frequency'), ''),
    CAST(series.key AS INTEGER),
    cache.fetched_at
FROM fred_macro_data_cache AS cache,
     json_each(cache.payload_json, '$.series') AS series
WHERE json_valid(cache.payload_json)
  AND json_extract(series.value, '$.id') IS NOT NULL;

INSERT OR REPLACE INTO fred_observations (
    cache_key,
    series_id,
    observation_date,
    value,
    fetched_at
)
SELECT
    cache.cache_key,
    json_extract(series.value, '$.id'),
    json_extract(observation.value, '$.date'),
    CAST(json_extract(observation.value, '$.value') AS REAL),
    cache.fetched_at
FROM fred_macro_data_cache AS cache,
     json_each(cache.payload_json, '$.series') AS series,
     json_each(series.value, '$.observations') AS observation
WHERE json_valid(cache.payload_json)
  AND json_extract(series.value, '$.id') IS NOT NULL
  AND json_extract(observation.value, '$.date') IS NOT NULL
  AND json_extract(observation.value, '$.value') IS NOT NULL;
