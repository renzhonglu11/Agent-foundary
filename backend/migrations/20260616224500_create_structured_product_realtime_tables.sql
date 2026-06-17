CREATE TABLE IF NOT EXISTS structured_product_enrichment_runs (
    payload_key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS structured_product_enrichment_items (
    payload_key TEXT NOT NULL,
    item_index INTEGER NOT NULL,
    isin TEXT,
    display_name TEXT,
    issuer TEXT,
    instrument TEXT,
    underlying TEXT,
    asset_class TEXT,
    product_type TEXT,
    wkn TEXT,
    quantity REAL,
    avg_cost REAL,
    cost_basis REAL,
    quote_price REAL,
    quote_currency TEXT,
    quote_source TEXT,
    quote_day_high REAL,
    quote_day_low REAL,
    quote_timestamp TEXT,
    market_value REAL,
    leverage REAL,
    delta REAL,
    omega REAL,
    theta REAL,
    iv REAL,
    strike_price REAL,
    knockout_price REAL,
    break_even REAL,
    ratio REAL,
    expiry TEXT,
    option_type TEXT,
    reset_barrier REAL,
    metadata_source TEXT,
    greeks_source TEXT,
    metadata_url TEXT,
    enrichment_tier TEXT,
    live_enrichment_enabled INTEGER,
    last_trade_date TEXT,
    source_generated_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (payload_key, item_index),
    FOREIGN KEY (payload_key) REFERENCES structured_product_enrichment_runs(payload_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_structured_product_enrichment_items_isin
ON structured_product_enrichment_items(isin);

CREATE INDEX IF NOT EXISTS idx_structured_product_enrichment_items_underlying
ON structured_product_enrichment_items(underlying);

CREATE TABLE IF NOT EXISTS structured_product_risk_runs (
    payload_key TEXT PRIMARY KEY,
    group_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS structured_product_risk_groups (
    payload_key TEXT NOT NULL,
    group_index INTEGER NOT NULL,
    symbol TEXT,
    pre_enrichment_tier INTEGER,
    group_market_value REAL,
    net_equivalent_exposure REAL,
    gross_equivalent_exposure REAL,
    net_weight_pct REAL,
    gross_weight_pct REAL,
    group_action_label TEXT,
    action_group_action_label TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (payload_key, group_index),
    FOREIGN KEY (payload_key) REFERENCES structured_product_risk_runs(payload_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_structured_product_risk_groups_symbol
ON structured_product_risk_groups(symbol);

CREATE TABLE IF NOT EXISTS structured_product_risk_actions (
    payload_key TEXT NOT NULL,
    group_index INTEGER NOT NULL,
    action_kind TEXT NOT NULL,
    action_index INTEGER NOT NULL,
    action TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (payload_key, group_index, action_kind, action_index),
    FOREIGN KEY (payload_key, group_index) REFERENCES structured_product_risk_groups(payload_key, group_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_structured_product_risk_actions_action
ON structured_product_risk_actions(action);

CREATE TABLE IF NOT EXISTS structured_product_risk_legs (
    payload_key TEXT NOT NULL,
    group_index INTEGER NOT NULL,
    leg_index INTEGER NOT NULL,
    isin TEXT,
    product_type TEXT,
    market_value REAL,
    delta REAL,
    delta_exposure REAL,
    days_to_expiry REAL,
    barrier_distance_pct REAL,
    quote_age_hours REAL,
    exposure_confidence TEXT,
    data_completeness_risk_score REAL,
    leg_risk_status TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (payload_key, group_index, leg_index),
    FOREIGN KEY (payload_key, group_index) REFERENCES structured_product_risk_groups(payload_key, group_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_structured_product_risk_legs_isin
ON structured_product_risk_legs(isin);

INSERT OR REPLACE INTO structured_product_enrichment_runs (
    payload_key,
    source,
    item_count,
    updated_at
)
SELECT
    key,
    COALESCE(json_extract(payload_json, '$.source'), ''),
    COALESCE(CAST(json_extract(payload_json, '$.count') AS INTEGER), 0),
    updated_at
FROM realtime_payloads
WHERE key = 'structured_products_enrichment'
  AND json_valid(payload_json);

INSERT OR REPLACE INTO structured_product_enrichment_items (
    payload_key,
    item_index,
    isin,
    display_name,
    issuer,
    instrument,
    underlying,
    asset_class,
    product_type,
    wkn,
    quantity,
    avg_cost,
    cost_basis,
    quote_price,
    quote_currency,
    quote_source,
    quote_day_high,
    quote_day_low,
    quote_timestamp,
    market_value,
    leverage,
    delta,
    omega,
    theta,
    iv,
    strike_price,
    knockout_price,
    break_even,
    ratio,
    expiry,
    option_type,
    reset_barrier,
    metadata_source,
    greeks_source,
    metadata_url,
    enrichment_tier,
    live_enrichment_enabled,
    last_trade_date,
    source_generated_at,
    updated_at
)
SELECT
    payload.key,
    CAST(item.key AS INTEGER),
    json_extract(item.value, '$.isin'),
    json_extract(item.value, '$.display_name'),
    json_extract(item.value, '$.issuer'),
    json_extract(item.value, '$.instrument'),
    json_extract(item.value, '$.underlying'),
    json_extract(item.value, '$.asset_class'),
    json_extract(item.value, '$.product_type'),
    json_extract(item.value, '$.wkn'),
    json_extract(item.value, '$.quantity'),
    json_extract(item.value, '$.avg_cost'),
    json_extract(item.value, '$.cost_basis'),
    json_extract(item.value, '$.quote_price'),
    json_extract(item.value, '$.quote_currency'),
    json_extract(item.value, '$.quote_source'),
    json_extract(item.value, '$.quote_day_high'),
    json_extract(item.value, '$.quote_day_low'),
    json_extract(item.value, '$.quote_timestamp'),
    json_extract(item.value, '$.market_value'),
    json_extract(item.value, '$.leverage'),
    json_extract(item.value, '$.delta'),
    json_extract(item.value, '$.omega'),
    json_extract(item.value, '$.theta'),
    json_extract(item.value, '$.iv'),
    json_extract(item.value, '$.strike_price'),
    json_extract(item.value, '$.knockout_price'),
    json_extract(item.value, '$.break_even'),
    json_extract(item.value, '$.ratio'),
    json_extract(item.value, '$.expiry'),
    json_extract(item.value, '$.option_type'),
    json_extract(item.value, '$.reset_barrier'),
    json_extract(item.value, '$.metadata_source'),
    json_extract(item.value, '$.greeks_source'),
    json_extract(item.value, '$.metadata_url'),
    json_extract(item.value, '$.enrichment_tier'),
    json_extract(item.value, '$.live_enrichment_enabled'),
    json_extract(item.value, '$.last_trade_date'),
    json_extract(item.value, '$.source_generated_at'),
    payload.updated_at
FROM realtime_payloads AS payload,
     json_each(payload.payload_json, '$.items') AS item
WHERE payload.key = 'structured_products_enrichment'
  AND json_valid(payload.payload_json);

INSERT OR REPLACE INTO structured_product_risk_runs (
    payload_key,
    group_count,
    updated_at
)
SELECT
    key,
    json_array_length(payload_json),
    updated_at
FROM realtime_payloads
WHERE key = 'structured_products_risk'
  AND json_valid(payload_json);

INSERT OR REPLACE INTO structured_product_risk_groups (
    payload_key,
    group_index,
    symbol,
    pre_enrichment_tier,
    group_market_value,
    net_equivalent_exposure,
    gross_equivalent_exposure,
    net_weight_pct,
    gross_weight_pct,
    group_action_label,
    action_group_action_label,
    updated_at
)
SELECT
    payload.key,
    CAST(risk_group.key AS INTEGER),
    json_extract(risk_group.value, '$.symbol'),
    json_extract(risk_group.value, '$.preEnrichmentTier'),
    json_extract(risk_group.value, '$.groupMarketValue'),
    json_extract(risk_group.value, '$.netEquivalentExposure'),
    json_extract(risk_group.value, '$.grossEquivalentExposure'),
    json_extract(risk_group.value, '$.netWeightPct'),
    json_extract(risk_group.value, '$.grossWeightPct'),
    json_extract(risk_group.value, '$.groupActionLabel'),
    json_extract(risk_group.value, '$.action.groupActionLabel'),
    payload.updated_at
FROM realtime_payloads AS payload,
     json_each(payload.payload_json) AS risk_group
WHERE payload.key = 'structured_products_risk'
  AND json_valid(payload.payload_json);

INSERT OR REPLACE INTO structured_product_risk_actions (
    payload_key,
    group_index,
    action_kind,
    action_index,
    action,
    updated_at
)
SELECT
    payload.key,
    CAST(risk_group.key AS INTEGER),
    'allowed',
    CAST(action.key AS INTEGER),
    action.value,
    payload.updated_at
FROM realtime_payloads AS payload,
     json_each(payload.payload_json) AS risk_group,
     json_each(risk_group.value, '$.action.allowedActions') AS action
WHERE payload.key = 'structured_products_risk'
  AND json_valid(payload.payload_json)
UNION ALL
SELECT
    payload.key,
    CAST(risk_group.key AS INTEGER),
    'blocked',
    CAST(action.key AS INTEGER),
    action.value,
    payload.updated_at
FROM realtime_payloads AS payload,
     json_each(payload.payload_json) AS risk_group,
     json_each(risk_group.value, '$.action.blockedActions') AS action
WHERE payload.key = 'structured_products_risk'
  AND json_valid(payload.payload_json);

INSERT OR REPLACE INTO structured_product_risk_legs (
    payload_key,
    group_index,
    leg_index,
    isin,
    product_type,
    market_value,
    delta,
    delta_exposure,
    days_to_expiry,
    barrier_distance_pct,
    quote_age_hours,
    exposure_confidence,
    data_completeness_risk_score,
    leg_risk_status,
    updated_at
)
SELECT
    payload.key,
    CAST(risk_group.key AS INTEGER),
    CAST(leg.key AS INTEGER),
    json_extract(leg.value, '$.isin'),
    json_extract(leg.value, '$.productType'),
    json_extract(leg.value, '$.marketValue'),
    json_extract(leg.value, '$.delta'),
    json_extract(leg.value, '$.deltaExposure'),
    json_extract(leg.value, '$.daysToExpiry'),
    json_extract(leg.value, '$.barrierDistancePct'),
    json_extract(leg.value, '$.quoteAgeHours'),
    json_extract(leg.value, '$.exposureConfidence'),
    json_extract(leg.value, '$.dataCompletenessRiskScore'),
    json_extract(leg.value, '$.legRiskStatus'),
    payload.updated_at
FROM realtime_payloads AS payload,
     json_each(payload.payload_json) AS risk_group,
     json_each(risk_group.value, '$.legs') AS leg
WHERE payload.key = 'structured_products_risk'
  AND json_valid(payload.payload_json);
