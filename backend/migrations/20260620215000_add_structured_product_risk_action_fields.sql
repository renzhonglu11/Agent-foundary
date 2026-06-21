ALTER TABLE structured_product_risk_groups
ADD COLUMN derivative_net_equivalent_exposure REAL;

ALTER TABLE structured_product_risk_groups
ADD COLUMN derivative_gross_equivalent_exposure REAL;

ALTER TABLE structured_product_risk_groups
ADD COLUMN derivative_net_weight_pct REAL;

ALTER TABLE structured_product_risk_groups
ADD COLUMN derivative_gross_weight_pct REAL;

ALTER TABLE structured_product_risk_legs
ADD COLUMN leverage REAL;

ALTER TABLE structured_product_risk_legs
ADD COLUMN exposure_weight_pct REAL;

ALTER TABLE structured_product_risk_legs
ADD COLUMN primary_action TEXT;

ALTER TABLE structured_product_risk_legs
ADD COLUMN action_reason TEXT;

UPDATE structured_product_risk_groups
SET
    derivative_net_equivalent_exposure = (
        SELECT json_extract(risk_group.value, '$.derivativeNetEquivalentExposure')
        FROM realtime_payloads AS payload,
             json_each(payload.payload_json) AS risk_group
        WHERE payload.key = structured_product_risk_groups.payload_key
          AND payload.key = 'structured_products_risk'
          AND CAST(risk_group.key AS INTEGER) = structured_product_risk_groups.group_index
          AND json_valid(payload.payload_json)
    ),
    derivative_gross_equivalent_exposure = (
        SELECT json_extract(risk_group.value, '$.derivativeGrossEquivalentExposure')
        FROM realtime_payloads AS payload,
             json_each(payload.payload_json) AS risk_group
        WHERE payload.key = structured_product_risk_groups.payload_key
          AND payload.key = 'structured_products_risk'
          AND CAST(risk_group.key AS INTEGER) = structured_product_risk_groups.group_index
          AND json_valid(payload.payload_json)
    ),
    derivative_net_weight_pct = (
        SELECT json_extract(risk_group.value, '$.derivativeNetWeightPct')
        FROM realtime_payloads AS payload,
             json_each(payload.payload_json) AS risk_group
        WHERE payload.key = structured_product_risk_groups.payload_key
          AND payload.key = 'structured_products_risk'
          AND CAST(risk_group.key AS INTEGER) = structured_product_risk_groups.group_index
          AND json_valid(payload.payload_json)
    ),
    derivative_gross_weight_pct = (
        SELECT json_extract(risk_group.value, '$.derivativeGrossWeightPct')
        FROM realtime_payloads AS payload,
             json_each(payload.payload_json) AS risk_group
        WHERE payload.key = structured_product_risk_groups.payload_key
          AND payload.key = 'structured_products_risk'
          AND CAST(risk_group.key AS INTEGER) = structured_product_risk_groups.group_index
          AND json_valid(payload.payload_json)
    )
WHERE payload_key = 'structured_products_risk';

UPDATE structured_product_risk_legs
SET
    leverage = (
        SELECT json_extract(leg.value, '$.leverage')
        FROM realtime_payloads AS payload,
             json_each(payload.payload_json) AS risk_group,
             json_each(risk_group.value, '$.legs') AS leg
        WHERE payload.key = structured_product_risk_legs.payload_key
          AND payload.key = 'structured_products_risk'
          AND CAST(risk_group.key AS INTEGER) = structured_product_risk_legs.group_index
          AND CAST(leg.key AS INTEGER) = structured_product_risk_legs.leg_index
          AND json_valid(payload.payload_json)
    ),
    exposure_weight_pct = (
        SELECT json_extract(leg.value, '$.exposureWeightPct')
        FROM realtime_payloads AS payload,
             json_each(payload.payload_json) AS risk_group,
             json_each(risk_group.value, '$.legs') AS leg
        WHERE payload.key = structured_product_risk_legs.payload_key
          AND payload.key = 'structured_products_risk'
          AND CAST(risk_group.key AS INTEGER) = structured_product_risk_legs.group_index
          AND CAST(leg.key AS INTEGER) = structured_product_risk_legs.leg_index
          AND json_valid(payload.payload_json)
    ),
    primary_action = (
        SELECT json_extract(leg.value, '$.primaryAction')
        FROM realtime_payloads AS payload,
             json_each(payload.payload_json) AS risk_group,
             json_each(risk_group.value, '$.legs') AS leg
        WHERE payload.key = structured_product_risk_legs.payload_key
          AND payload.key = 'structured_products_risk'
          AND CAST(risk_group.key AS INTEGER) = structured_product_risk_legs.group_index
          AND CAST(leg.key AS INTEGER) = structured_product_risk_legs.leg_index
          AND json_valid(payload.payload_json)
    ),
    action_reason = (
        SELECT json_extract(leg.value, '$.actionReason')
        FROM realtime_payloads AS payload,
             json_each(payload.payload_json) AS risk_group,
             json_each(risk_group.value, '$.legs') AS leg
        WHERE payload.key = structured_product_risk_legs.payload_key
          AND payload.key = 'structured_products_risk'
          AND CAST(risk_group.key AS INTEGER) = structured_product_risk_legs.group_index
          AND CAST(leg.key AS INTEGER) = structured_product_risk_legs.leg_index
          AND json_valid(payload.payload_json)
    )
WHERE payload_key = 'structured_products_risk';
