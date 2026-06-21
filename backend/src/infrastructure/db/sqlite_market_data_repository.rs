use chrono::{DateTime, Utc};
use serde_json::{Map, Number, Value};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};

use crate::application::ports::market_data_repository::{
    MarketDataRepository, MarketQuoteRecord, RealtimePayloadRecord,
};

const STRUCTURED_PRODUCTS_PAYLOAD_KEY: &str = "structured_products_enrichment";
const STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY: &str = "structured_products_risk";

#[derive(Debug, Clone)]
pub struct SqliteMarketDataRepository {
    pool: SqlitePool,
}

impl SqliteMarketDataRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    async fn load_normalized_payload_record(
        &self,
        key: &str,
    ) -> anyhow::Result<Option<RealtimePayloadRecord>> {
        match key {
            STRUCTURED_PRODUCTS_PAYLOAD_KEY => self.load_structured_products_enrichment().await,
            STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY => self.load_structured_products_risk().await,
            _ => Ok(None),
        }
    }

    async fn load_structured_products_enrichment(
        &self,
    ) -> anyhow::Result<Option<RealtimePayloadRecord>> {
        let Some(run) = sqlx::query(
            r#"
            SELECT source, item_count, updated_at
            FROM structured_product_enrichment_runs
            WHERE payload_key = ?1
            "#,
        )
        .bind(STRUCTURED_PRODUCTS_PAYLOAD_KEY)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };

        let item_rows = sqlx::query(
            r#"
            SELECT isin, display_name, issuer, instrument, underlying, asset_class, product_type,
                   wkn, quantity, avg_cost, cost_basis, quote_price, quote_currency, quote_source,
                   quote_day_high, quote_day_low, quote_timestamp, market_value, leverage, delta,
                   omega, theta, iv, strike_price, knockout_price, break_even, ratio, expiry,
                   option_type, reset_barrier, metadata_source, greeks_source, metadata_url,
                   enrichment_tier, live_enrichment_enabled, last_trade_date, source_generated_at
            FROM structured_product_enrichment_items
            WHERE payload_key = ?1
            ORDER BY item_index ASC
            "#,
        )
        .bind(STRUCTURED_PRODUCTS_PAYLOAD_KEY)
        .fetch_all(&self.pool)
        .await?;

        let mut items = Vec::with_capacity(item_rows.len());
        for row in item_rows {
            let mut item = Map::new();
            insert_string(&mut item, "isin", row.try_get("isin")?);
            insert_string(&mut item, "display_name", row.try_get("display_name")?);
            insert_string(&mut item, "issuer", row.try_get("issuer")?);
            insert_string(&mut item, "instrument", row.try_get("instrument")?);
            insert_string(&mut item, "underlying", row.try_get("underlying")?);
            insert_string(&mut item, "asset_class", row.try_get("asset_class")?);
            insert_string(&mut item, "product_type", row.try_get("product_type")?);
            insert_string(&mut item, "wkn", row.try_get("wkn")?);
            insert_f64(&mut item, "quantity", row.try_get("quantity")?);
            insert_f64(&mut item, "avg_cost", row.try_get("avg_cost")?);
            insert_f64(&mut item, "cost_basis", row.try_get("cost_basis")?);
            insert_f64(&mut item, "quote_price", row.try_get("quote_price")?);
            insert_string(&mut item, "quote_currency", row.try_get("quote_currency")?);
            insert_string(&mut item, "quote_source", row.try_get("quote_source")?);
            insert_f64(&mut item, "quote_day_high", row.try_get("quote_day_high")?);
            insert_f64(&mut item, "quote_day_low", row.try_get("quote_day_low")?);
            insert_string(
                &mut item,
                "quote_timestamp",
                row.try_get("quote_timestamp")?,
            );
            insert_f64(&mut item, "market_value", row.try_get("market_value")?);
            insert_f64(&mut item, "leverage", row.try_get("leverage")?);
            insert_f64(&mut item, "delta", row.try_get("delta")?);
            insert_f64(&mut item, "omega", row.try_get("omega")?);
            insert_f64(&mut item, "theta", row.try_get("theta")?);
            insert_f64(&mut item, "iv", row.try_get("iv")?);
            insert_f64(&mut item, "strike_price", row.try_get("strike_price")?);
            insert_f64(&mut item, "knockout_price", row.try_get("knockout_price")?);
            insert_f64(&mut item, "break_even", row.try_get("break_even")?);
            insert_f64(&mut item, "ratio", row.try_get("ratio")?);
            insert_string(&mut item, "expiry", row.try_get("expiry")?);
            insert_string(&mut item, "option_type", row.try_get("option_type")?);
            insert_f64(&mut item, "reset_barrier", row.try_get("reset_barrier")?);
            insert_string(
                &mut item,
                "metadata_source",
                row.try_get("metadata_source")?,
            );
            insert_string(&mut item, "greeks_source", row.try_get("greeks_source")?);
            insert_string(&mut item, "metadata_url", row.try_get("metadata_url")?);
            insert_string(
                &mut item,
                "enrichment_tier",
                row.try_get("enrichment_tier")?,
            );
            insert_bool(
                &mut item,
                "live_enrichment_enabled",
                row.try_get::<Option<i64>, _>("live_enrichment_enabled")?,
            );
            insert_string(
                &mut item,
                "last_trade_date",
                row.try_get("last_trade_date")?,
            );
            insert_string(
                &mut item,
                "source_generated_at",
                row.try_get("source_generated_at")?,
            );
            items.push(Value::Object(item));
        }

        let mut payload = Map::new();
        insert_string(
            &mut payload,
            "source",
            Some(run.try_get::<String, _>("source")?),
        );
        insert_i64(
            &mut payload,
            "count",
            Some(run.try_get::<i64, _>("item_count")?),
        );
        payload.insert("items".to_owned(), Value::Array(items));

        Ok(Some(RealtimePayloadRecord {
            payload_json: serde_json::to_string(&Value::Object(payload))?,
            updated_at: run.try_get("updated_at")?,
        }))
    }

    async fn load_structured_products_risk(&self) -> anyhow::Result<Option<RealtimePayloadRecord>> {
        let Some(run) = sqlx::query(
            r#"
            SELECT updated_at
            FROM structured_product_risk_runs
            WHERE payload_key = ?1
            "#,
        )
        .bind(STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };

        let group_rows = sqlx::query(
            r#"
            SELECT group_index, symbol, pre_enrichment_tier, group_market_value,
                   net_equivalent_exposure, gross_equivalent_exposure, net_weight_pct,
                   gross_weight_pct, derivative_net_equivalent_exposure,
                   derivative_gross_equivalent_exposure, derivative_net_weight_pct,
                   derivative_gross_weight_pct, group_action_label, action_group_action_label
            FROM structured_product_risk_groups
            WHERE payload_key = ?1
            ORDER BY group_index ASC
            "#,
        )
        .bind(STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY)
        .fetch_all(&self.pool)
        .await?;

        let mut groups = Vec::with_capacity(group_rows.len());
        for group_row in group_rows {
            let group_index: i64 = group_row.try_get("group_index")?;
            let mut group = Map::new();
            insert_string(&mut group, "symbol", group_row.try_get("symbol")?);
            insert_i64(
                &mut group,
                "preEnrichmentTier",
                group_row.try_get("pre_enrichment_tier")?,
            );
            insert_f64(
                &mut group,
                "groupMarketValue",
                group_row.try_get("group_market_value")?,
            );
            insert_f64(
                &mut group,
                "netEquivalentExposure",
                group_row.try_get("net_equivalent_exposure")?,
            );
            insert_f64(
                &mut group,
                "grossEquivalentExposure",
                group_row.try_get("gross_equivalent_exposure")?,
            );
            insert_f64(
                &mut group,
                "netWeightPct",
                group_row.try_get("net_weight_pct")?,
            );
            insert_f64(
                &mut group,
                "grossWeightPct",
                group_row.try_get("gross_weight_pct")?,
            );
            insert_f64(
                &mut group,
                "derivativeNetEquivalentExposure",
                group_row.try_get("derivative_net_equivalent_exposure")?,
            );
            insert_f64(
                &mut group,
                "derivativeGrossEquivalentExposure",
                group_row.try_get("derivative_gross_equivalent_exposure")?,
            );
            insert_f64(
                &mut group,
                "derivativeNetWeightPct",
                group_row.try_get("derivative_net_weight_pct")?,
            );
            insert_f64(
                &mut group,
                "derivativeGrossWeightPct",
                group_row.try_get("derivative_gross_weight_pct")?,
            );
            insert_string(
                &mut group,
                "groupActionLabel",
                group_row.try_get("group_action_label")?,
            );

            let allowed_actions = self
                .load_structured_product_actions(group_index, "allowed")
                .await?;
            let blocked_actions = self
                .load_structured_product_actions(group_index, "blocked")
                .await?;
            let mut action = Map::new();
            insert_string(
                &mut action,
                "groupActionLabel",
                group_row.try_get("action_group_action_label")?,
            );
            action.insert("blockedActions".to_owned(), Value::Array(blocked_actions));
            action.insert("allowedActions".to_owned(), Value::Array(allowed_actions));
            group.insert("action".to_owned(), Value::Object(action));

            let legs = self.load_structured_product_risk_legs(group_index).await?;
            group.insert("legs".to_owned(), Value::Array(legs));
            groups.push(Value::Object(group));
        }

        Ok(Some(RealtimePayloadRecord {
            payload_json: serde_json::to_string(&Value::Array(groups))?,
            updated_at: run.try_get("updated_at")?,
        }))
    }

    async fn load_structured_product_actions(
        &self,
        group_index: i64,
        action_kind: &str,
    ) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query(
            r#"
            SELECT action
            FROM structured_product_risk_actions
            WHERE payload_key = ?1 AND group_index = ?2 AND action_kind = ?3
            ORDER BY action_index ASC
            "#,
        )
        .bind(STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY)
        .bind(group_index)
        .bind(action_kind)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| Ok(Value::String(row.try_get("action")?)))
            .collect::<Result<Vec<_>, sqlx::Error>>()
            .map_err(Into::into)
    }

    async fn load_structured_product_risk_legs(
        &self,
        group_index: i64,
    ) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query(
            r#"
            SELECT isin, product_type, market_value, delta, leverage, delta_exposure,
                   exposure_weight_pct, days_to_expiry, barrier_distance_pct, quote_age_hours,
                   exposure_confidence, data_completeness_risk_score, leg_risk_status,
                   primary_action, action_reason
            FROM structured_product_risk_legs
            WHERE payload_key = ?1 AND group_index = ?2
            ORDER BY leg_index ASC
            "#,
        )
        .bind(STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY)
        .bind(group_index)
        .fetch_all(&self.pool)
        .await?;

        let mut legs = Vec::with_capacity(rows.len());
        for row in rows {
            let mut leg = Map::new();
            insert_string(&mut leg, "isin", row.try_get("isin")?);
            insert_string(&mut leg, "productType", row.try_get("product_type")?);
            insert_f64(&mut leg, "marketValue", row.try_get("market_value")?);
            insert_f64(&mut leg, "delta", row.try_get("delta")?);
            insert_f64(&mut leg, "leverage", row.try_get("leverage")?);
            insert_f64(&mut leg, "deltaExposure", row.try_get("delta_exposure")?);
            insert_f64(
                &mut leg,
                "exposureWeightPct",
                row.try_get("exposure_weight_pct")?,
            );
            insert_f64(&mut leg, "daysToExpiry", row.try_get("days_to_expiry")?);
            insert_f64(
                &mut leg,
                "barrierDistancePct",
                row.try_get("barrier_distance_pct")?,
            );
            insert_f64(&mut leg, "quoteAgeHours", row.try_get("quote_age_hours")?);
            insert_string(
                &mut leg,
                "exposureConfidence",
                row.try_get("exposure_confidence")?,
            );
            insert_f64(
                &mut leg,
                "dataCompletenessRiskScore",
                row.try_get("data_completeness_risk_score")?,
            );
            insert_string(&mut leg, "legRiskStatus", row.try_get("leg_risk_status")?);
            insert_string(&mut leg, "primaryAction", row.try_get("primary_action")?);
            insert_string(&mut leg, "actionReason", row.try_get("action_reason")?);
            legs.push(Value::Object(leg));
        }

        Ok(legs)
    }

    async fn store_normalized_payload(
        tx: &mut Transaction<'_, Sqlite>,
        key: &str,
        payload_json: &str,
        updated_at: &str,
    ) -> anyhow::Result<()> {
        match key {
            STRUCTURED_PRODUCTS_PAYLOAD_KEY => {
                store_structured_products_enrichment(tx, payload_json, updated_at).await
            }
            STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY => {
                store_structured_products_risk(tx, payload_json, updated_at).await
            }
            _ => Ok(()),
        }
    }
}

#[async_trait::async_trait]
impl MarketDataRepository for SqliteMarketDataRepository {
    async fn load_quotes(
        &self,
        provider: &str,
        feed: &str,
        symbols: &[String],
    ) -> anyhow::Result<Vec<MarketQuoteRecord>> {
        let mut records = Vec::new();

        for symbol in symbols {
            let Some(row) = sqlx::query(
                r#"
                SELECT provider, feed, symbol, price, currency, bid_price, ask_price,
                       raw_price, raw_bid_price, raw_ask_price, raw_currency, usd_eur_rate,
                       fx_rate_source, bid_size, ask_size, price_source, price_as_of, fetched_at
                FROM market_data_quotes
                WHERE provider = ?1 AND feed = ?2 AND symbol = ?3
                "#,
            )
            .bind(provider)
            .bind(feed)
            .bind(symbol)
            .fetch_optional(&self.pool)
            .await?
            else {
                continue;
            };

            let fetched_at =
                DateTime::parse_from_rfc3339(&row.try_get::<String, _>("fetched_at")?)?
                    .with_timezone(&Utc);

            records.push(MarketQuoteRecord {
                provider: row.try_get("provider")?,
                feed: row.try_get("feed")?,
                symbol: row.try_get("symbol")?,
                price: row.try_get("price")?,
                currency: row.try_get("currency")?,
                bid_price: row.try_get("bid_price")?,
                ask_price: row.try_get("ask_price")?,
                raw_price: row.try_get("raw_price")?,
                raw_bid_price: row.try_get("raw_bid_price")?,
                raw_ask_price: row.try_get("raw_ask_price")?,
                raw_currency: row.try_get("raw_currency")?,
                usd_eur_rate: row.try_get("usd_eur_rate")?,
                fx_rate_source: row.try_get("fx_rate_source")?,
                bid_size: row.try_get("bid_size")?,
                ask_size: row.try_get("ask_size")?,
                price_source: row.try_get("price_source")?,
                price_as_of: row.try_get("price_as_of")?,
                fetched_at,
            });
        }

        Ok(records)
    }

    async fn store_quotes(&self, quotes: &[MarketQuoteRecord]) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;

        for quote in quotes {
            sqlx::query(
                r#"
                INSERT INTO market_data_quotes (
                    provider, feed, symbol, price, currency, bid_price, ask_price,
                    raw_price, raw_bid_price, raw_ask_price, raw_currency, usd_eur_rate,
                    fx_rate_source, bid_size, ask_size, price_source, price_as_of, fetched_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
                ON CONFLICT(provider, feed, symbol) DO UPDATE SET
                    price = excluded.price,
                    currency = excluded.currency,
                    bid_price = excluded.bid_price,
                    ask_price = excluded.ask_price,
                    raw_price = excluded.raw_price,
                    raw_bid_price = excluded.raw_bid_price,
                    raw_ask_price = excluded.raw_ask_price,
                    raw_currency = excluded.raw_currency,
                    usd_eur_rate = excluded.usd_eur_rate,
                    fx_rate_source = excluded.fx_rate_source,
                    bid_size = excluded.bid_size,
                    ask_size = excluded.ask_size,
                    price_source = excluded.price_source,
                    price_as_of = excluded.price_as_of,
                    fetched_at = excluded.fetched_at
                "#,
            )
            .bind(&quote.provider)
            .bind(&quote.feed)
            .bind(&quote.symbol)
            .bind(quote.price)
            .bind(&quote.currency)
            .bind(quote.bid_price)
            .bind(quote.ask_price)
            .bind(quote.raw_price)
            .bind(quote.raw_bid_price)
            .bind(quote.raw_ask_price)
            .bind(&quote.raw_currency)
            .bind(quote.usd_eur_rate)
            .bind(&quote.fx_rate_source)
            .bind(quote.bid_size)
            .bind(quote.ask_size)
            .bind(&quote.price_source)
            .bind(&quote.price_as_of)
            .bind(quote.fetched_at.to_rfc3339())
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    async fn load_payload(&self, key: &str) -> anyhow::Result<Option<String>> {
        Ok(self
            .load_payload_record(key)
            .await?
            .map(|record| record.payload_json))
    }

    async fn load_payload_record(
        &self,
        key: &str,
    ) -> anyhow::Result<Option<RealtimePayloadRecord>> {
        if let Some(record) = self.load_normalized_payload_record(key).await? {
            return Ok(Some(record));
        }

        let Some(row) = sqlx::query(
            r#"
            SELECT payload_json, updated_at
            FROM realtime_payloads
            WHERE key = ?1
            "#,
        )
        .bind(key)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };

        Ok(Some(RealtimePayloadRecord {
            payload_json: row.try_get("payload_json")?,
            updated_at: row.try_get("updated_at")?,
        }))
    }

    async fn store_payload(
        &self,
        key: &str,
        payload_json: &str,
        updated_at: &str,
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;

        sqlx::query(
            r#"
            INSERT INTO realtime_payloads (key, payload_json, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET
                payload_json = excluded.payload_json,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(key)
        .bind(payload_json)
        .bind(updated_at)
        .execute(&mut *tx)
        .await?;

        Self::store_normalized_payload(&mut tx, key, payload_json, updated_at).await?;

        tx.commit().await?;
        Ok(())
    }
}

async fn store_structured_products_enrichment(
    tx: &mut Transaction<'_, Sqlite>,
    payload_json: &str,
    updated_at: &str,
) -> anyhow::Result<()> {
    let payload: Value = serde_json::from_str(payload_json)?;
    let source = payload
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let items = payload
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let item_count = payload
        .get("count")
        .and_then(Value::as_i64)
        .unwrap_or(items.len() as i64);

    sqlx::query(
        r#"
        INSERT INTO structured_product_enrichment_runs (payload_key, source, item_count, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(payload_key) DO UPDATE SET
            source = excluded.source,
            item_count = excluded.item_count,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(STRUCTURED_PRODUCTS_PAYLOAD_KEY)
    .bind(source)
    .bind(item_count)
    .bind(updated_at)
    .execute(&mut **tx)
    .await?;

    sqlx::query("DELETE FROM structured_product_enrichment_items WHERE payload_key = ?1")
        .bind(STRUCTURED_PRODUCTS_PAYLOAD_KEY)
        .execute(&mut **tx)
        .await?;

    for (item_index, item) in items.iter().enumerate() {
        sqlx::query(
            r#"
            INSERT INTO structured_product_enrichment_items (
                payload_key, item_index, isin, display_name, issuer, instrument, underlying,
                asset_class, product_type, wkn, quantity, avg_cost, cost_basis, quote_price,
                quote_currency, quote_source, quote_day_high, quote_day_low, quote_timestamp,
                market_value, leverage, delta, omega, theta, iv, strike_price, knockout_price,
                break_even, ratio, expiry, option_type, reset_barrier, metadata_source,
                greeks_source, metadata_url, enrichment_tier, live_enrichment_enabled,
                last_trade_date, source_generated_at, updated_at
            )
            VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28,
                ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40
            )
            "#,
        )
        .bind(STRUCTURED_PRODUCTS_PAYLOAD_KEY)
        .bind(i64::try_from(item_index)?)
        .bind(json_string(item, "isin"))
        .bind(json_string(item, "display_name"))
        .bind(json_string(item, "issuer"))
        .bind(json_string(item, "instrument"))
        .bind(json_string(item, "underlying"))
        .bind(json_string(item, "asset_class"))
        .bind(json_string(item, "product_type"))
        .bind(json_string(item, "wkn"))
        .bind(json_f64(item, "quantity"))
        .bind(json_f64(item, "avg_cost"))
        .bind(json_f64(item, "cost_basis"))
        .bind(json_f64(item, "quote_price"))
        .bind(json_string(item, "quote_currency"))
        .bind(json_string(item, "quote_source"))
        .bind(json_f64(item, "quote_day_high"))
        .bind(json_f64(item, "quote_day_low"))
        .bind(json_string(item, "quote_timestamp"))
        .bind(json_f64(item, "market_value"))
        .bind(json_f64(item, "leverage"))
        .bind(json_f64(item, "delta"))
        .bind(json_f64(item, "omega"))
        .bind(json_f64(item, "theta"))
        .bind(json_f64(item, "iv"))
        .bind(json_f64(item, "strike_price"))
        .bind(json_f64(item, "knockout_price"))
        .bind(json_f64(item, "break_even"))
        .bind(json_f64(item, "ratio"))
        .bind(json_string(item, "expiry"))
        .bind(json_string(item, "option_type"))
        .bind(json_f64(item, "reset_barrier"))
        .bind(json_string(item, "metadata_source"))
        .bind(json_string(item, "greeks_source"))
        .bind(json_string(item, "metadata_url"))
        .bind(json_string(item, "enrichment_tier"))
        .bind(json_bool_i64(item, "live_enrichment_enabled"))
        .bind(json_string(item, "last_trade_date"))
        .bind(json_string(item, "source_generated_at"))
        .bind(updated_at)
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

async fn store_structured_products_risk(
    tx: &mut Transaction<'_, Sqlite>,
    payload_json: &str,
    updated_at: &str,
) -> anyhow::Result<()> {
    let payload: Value = serde_json::from_str(payload_json)?;
    let groups = payload.as_array().cloned().unwrap_or_default();

    sqlx::query(
        r#"
        INSERT INTO structured_product_risk_runs (payload_key, group_count, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(payload_key) DO UPDATE SET
            group_count = excluded.group_count,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY)
    .bind(i64::try_from(groups.len())?)
    .bind(updated_at)
    .execute(&mut **tx)
    .await?;

    sqlx::query("DELETE FROM structured_product_risk_actions WHERE payload_key = ?1")
        .bind(STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM structured_product_risk_legs WHERE payload_key = ?1")
        .bind(STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM structured_product_risk_groups WHERE payload_key = ?1")
        .bind(STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY)
        .execute(&mut **tx)
        .await?;

    for (group_index, group) in groups.iter().enumerate() {
        let group_index = i64::try_from(group_index)?;
        let action = group.get("action").unwrap_or(&Value::Null);

        sqlx::query(
            r#"
            INSERT INTO structured_product_risk_groups (
                payload_key, group_index, symbol, pre_enrichment_tier, group_market_value,
                net_equivalent_exposure, gross_equivalent_exposure, net_weight_pct,
                gross_weight_pct, derivative_net_equivalent_exposure,
                derivative_gross_equivalent_exposure, derivative_net_weight_pct,
                derivative_gross_weight_pct, group_action_label, action_group_action_label,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
            "#,
        )
        .bind(STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY)
        .bind(group_index)
        .bind(json_string(group, "symbol"))
        .bind(json_i64(group, "preEnrichmentTier"))
        .bind(json_f64(group, "groupMarketValue"))
        .bind(json_f64(group, "netEquivalentExposure"))
        .bind(json_f64(group, "grossEquivalentExposure"))
        .bind(json_f64(group, "netWeightPct"))
        .bind(json_f64(group, "grossWeightPct"))
        .bind(json_f64(group, "derivativeNetEquivalentExposure"))
        .bind(json_f64(group, "derivativeGrossEquivalentExposure"))
        .bind(json_f64(group, "derivativeNetWeightPct"))
        .bind(json_f64(group, "derivativeGrossWeightPct"))
        .bind(json_string(group, "groupActionLabel"))
        .bind(json_string(action, "groupActionLabel"))
        .bind(updated_at)
        .execute(&mut **tx)
        .await?;

        store_structured_product_actions(tx, group_index, "allowed", action, updated_at).await?;
        store_structured_product_actions(tx, group_index, "blocked", action, updated_at).await?;

        let legs = group
            .get("legs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (leg_index, leg) in legs.iter().enumerate() {
            sqlx::query(
                r#"
                INSERT INTO structured_product_risk_legs (
                    payload_key, group_index, leg_index, isin, product_type, market_value, delta,
                    leverage, delta_exposure, exposure_weight_pct, days_to_expiry,
                    barrier_distance_pct, quote_age_hours, exposure_confidence,
                    data_completeness_risk_score, leg_risk_status, primary_action,
                    action_reason, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
                "#,
            )
            .bind(STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY)
            .bind(group_index)
            .bind(i64::try_from(leg_index)?)
            .bind(json_string(leg, "isin"))
            .bind(json_string(leg, "productType"))
            .bind(json_f64(leg, "marketValue"))
            .bind(json_f64(leg, "delta"))
            .bind(json_f64(leg, "leverage"))
            .bind(json_f64(leg, "deltaExposure"))
            .bind(json_f64(leg, "exposureWeightPct"))
            .bind(json_f64(leg, "daysToExpiry"))
            .bind(json_f64(leg, "barrierDistancePct"))
            .bind(json_f64(leg, "quoteAgeHours"))
            .bind(json_string(leg, "exposureConfidence"))
            .bind(json_f64(leg, "dataCompletenessRiskScore"))
            .bind(json_string(leg, "legRiskStatus"))
            .bind(json_string(leg, "primaryAction"))
            .bind(json_string(leg, "actionReason"))
            .bind(updated_at)
            .execute(&mut **tx)
            .await?;
        }
    }

    Ok(())
}

async fn store_structured_product_actions(
    tx: &mut Transaction<'_, Sqlite>,
    group_index: i64,
    action_kind: &str,
    action: &Value,
    updated_at: &str,
) -> anyhow::Result<()> {
    let source_key = match action_kind {
        "allowed" => "allowedActions",
        "blocked" => "blockedActions",
        _ => return Ok(()),
    };
    let actions = action
        .get(source_key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for (action_index, action_value) in actions.iter().enumerate() {
        let Some(action_text) = action_value.as_str() else {
            continue;
        };

        sqlx::query(
            r#"
            INSERT INTO structured_product_risk_actions (
                payload_key, group_index, action_kind, action_index, action, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
        )
        .bind(STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY)
        .bind(group_index)
        .bind(action_kind)
        .bind(i64::try_from(action_index)?)
        .bind(action_text)
        .bind(updated_at)
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(ToOwned::to_owned)
}

fn json_f64(value: &Value, key: &str) -> Option<f64> {
    value.get(key)?.as_f64()
}

fn json_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key)?.as_i64()
}

fn json_bool_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key)?.as_bool().map(i64::from)
}

fn insert_string(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    map.insert(
        key.to_owned(),
        value.map(Value::String).unwrap_or(Value::Null),
    );
}

fn insert_f64(map: &mut Map<String, Value>, key: &str, value: Option<f64>) {
    map.insert(
        key.to_owned(),
        value
            .and_then(Number::from_f64)
            .map(Value::Number)
            .unwrap_or(Value::Null),
    );
}

fn insert_i64(map: &mut Map<String, Value>, key: &str, value: Option<i64>) {
    map.insert(
        key.to_owned(),
        value
            .map(Number::from)
            .map(Value::Number)
            .unwrap_or(Value::Null),
    );
}

fn insert_bool(map: &mut Map<String, Value>, key: &str, value: Option<i64>) {
    map.insert(
        key.to_owned(),
        value
            .map(|value| Value::Bool(value != 0))
            .unwrap_or(Value::Null),
    );
}

#[cfg(test)]
mod tests {
    use anyhow::Result;
    use serde_json::Value;
    use sqlx::{SqlitePool, sqlite::SqlitePoolOptions};

    use super::{
        STRUCTURED_PRODUCTS_PAYLOAD_KEY, STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY,
        SqliteMarketDataRepository,
    };
    use crate::application::ports::market_data_repository::MarketDataRepository;

    #[tokio::test]
    async fn stores_and_loads_structured_products_enrichment_from_normalized_tables() -> Result<()>
    {
        let pool = test_pool().await?;
        create_test_schema(&pool).await?;
        let repository = SqliteMarketDataRepository::new(pool.clone());
        let payload = r#"{
            "source": "test",
            "count": 1,
            "items": [{
                "isin": "DE000TEST001",
                "display_name": "Test Call",
                "issuer": "Issuer",
                "instrument": "Call",
                "underlying": "Micron",
                "asset_class": "DERIVATIVE",
                "product_type": "optionsschein",
                "wkn": "TEST01",
                "quantity": 2.0,
                "avg_cost": 1.5,
                "cost_basis": 3.0,
                "quote_price": 4.5,
                "quote_currency": "EUR",
                "quote_source": "boerse_frankfurt",
                "quote_day_high": null,
                "quote_day_low": null,
                "quote_timestamp": "2026-06-16T10:00:00Z",
                "market_value": 9.0,
                "leverage": 3.0,
                "delta": 0.5,
                "omega": 2.1,
                "theta": null,
                "iv": 0.42,
                "strike_price": 100.0,
                "knockout_price": null,
                "break_even": 105.0,
                "ratio": 0.1,
                "expiry": "2026-12-18",
                "option_type": "call",
                "reset_barrier": null,
                "metadata_source": "onvista",
                "greeks_source": "gs_de",
                "metadata_url": "https://example.test",
                "enrichment_tier": "tier1",
                "live_enrichment_enabled": true,
                "last_trade_date": "2026-06-15",
                "source_generated_at": "2026-06-16T09:00:00Z"
            }]
        }"#;

        repository
            .store_payload(
                STRUCTURED_PRODUCTS_PAYLOAD_KEY,
                payload,
                "2026-06-16T10:05:00Z",
            )
            .await?;
        overwrite_snapshot_with_empty_payload(&pool, STRUCTURED_PRODUCTS_PAYLOAD_KEY).await?;

        let item_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM structured_product_enrichment_items")
                .fetch_one(&pool)
                .await?;
        let loaded = repository
            .load_payload(STRUCTURED_PRODUCTS_PAYLOAD_KEY)
            .await?
            .ok_or_else(|| anyhow::anyhow!("expected enrichment payload"))?;
        let loaded: Value = serde_json::from_str(&loaded)?;

        assert_eq!(item_count, 1);
        assert_eq!(loaded["source"], "test");
        assert_eq!(loaded["items"][0]["isin"], "DE000TEST001");
        assert_eq!(loaded["items"][0]["quote_source"], "boerse_frankfurt");
        assert_eq!(loaded["items"][0]["live_enrichment_enabled"], true);

        Ok(())
    }

    #[tokio::test]
    async fn stores_and_loads_structured_products_risk_from_normalized_tables() -> Result<()> {
        let pool = test_pool().await?;
        create_test_schema(&pool).await?;
        let repository = SqliteMarketDataRepository::new(pool.clone());
        let payload = r#"[{
            "symbol": "micron technology",
            "preEnrichmentTier": 1,
            "groupMarketValue": 100.0,
            "netEquivalentExposure": 80.0,
            "grossEquivalentExposure": 120.0,
            "netWeightPct": 0.1,
            "grossWeightPct": 0.15,
            "derivativeNetEquivalentExposure": 80.0,
            "derivativeGrossEquivalentExposure": 120.0,
            "derivativeNetWeightPct": 0.1,
            "derivativeGrossWeightPct": 0.15,
            "groupActionLabel": "REDUCE_DERIVATIVE_RISK",
            "action": {
                "groupActionLabel": "REDUCE_DERIVATIVE_RISK",
                "blockedActions": ["BUY_MORE_DERIVATIVE"],
                "allowedActions": ["HOLD", "REDUCE"]
            },
            "legs": [{
                "isin": "DE000TEST001",
                "productType": "optionsschein",
                "marketValue": 100.0,
                "delta": 0.5,
                "leverage": 2.0,
                "deltaExposure": 80.0,
                "exposureWeightPct": 0.1,
                "daysToExpiry": 30,
                "barrierDistancePct": null,
                "quoteAgeHours": 2.5,
                "exposureConfidence": "greeks",
                "dataCompletenessRiskScore": 1,
                "legRiskStatus": "WATCH",
                "primaryAction": "REDUCE_RISK",
                "actionReason": "Product is on watch."
            }]
        }]"#;

        repository
            .store_payload(
                STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY,
                payload,
                "2026-06-16T10:05:00Z",
            )
            .await?;
        overwrite_snapshot_with_empty_payload(&pool, STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY).await?;

        let action_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM structured_product_risk_actions")
                .fetch_one(&pool)
                .await?;
        let leg_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM structured_product_risk_legs")
                .fetch_one(&pool)
                .await?;
        let loaded = repository
            .load_payload(STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY)
            .await?
            .ok_or_else(|| anyhow::anyhow!("expected risk payload"))?;
        let loaded: Value = serde_json::from_str(&loaded)?;

        assert_eq!(action_count, 3);
        assert_eq!(leg_count, 1);
        assert_eq!(loaded[0]["symbol"], "micron technology");
        assert_eq!(loaded[0]["action"]["allowedActions"][1], "REDUCE");
        assert_eq!(
            loaded[0]["action"]["blockedActions"][0],
            "BUY_MORE_DERIVATIVE"
        );
        assert_eq!(loaded[0]["derivativeGrossWeightPct"], 0.15);
        assert_eq!(loaded[0]["legs"][0]["leverage"], 2.0);
        assert_eq!(loaded[0]["legs"][0]["exposureWeightPct"], 0.1);
        assert_eq!(loaded[0]["legs"][0]["legRiskStatus"], "WATCH");
        assert_eq!(loaded[0]["legs"][0]["primaryAction"], "REDUCE_RISK");
        assert_eq!(loaded[0]["legs"][0]["actionReason"], "Product is on watch.");

        Ok(())
    }

    async fn test_pool() -> Result<SqlitePool> {
        Ok(SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?)
    }

    async fn create_test_schema(pool: &SqlitePool) -> Result<()> {
        sqlx::query(
            r#"
            CREATE TABLE realtime_payloads (
                key TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            "#,
        )
        .execute(pool)
        .await?;

        for migration in [
            include_str!(
                "../../../migrations/20260616224500_create_structured_product_realtime_tables.sql"
            ),
            include_str!(
                "../../../migrations/20260620215000_add_structured_product_risk_action_fields.sql"
            ),
        ] {
            for statement in migration
                .split(';')
                .map(str::trim)
                .filter(|statement| !statement.is_empty())
            {
                sqlx::query(statement).execute(pool).await?;
            }
        }

        Ok(())
    }

    async fn overwrite_snapshot_with_empty_payload(pool: &SqlitePool, key: &str) -> Result<()> {
        sqlx::query(
            r#"
            UPDATE realtime_payloads
            SET payload_json = ?1
            WHERE key = ?2
            "#,
        )
        .bind(if key == STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY {
            "[]"
        } else {
            r#"{"source":"legacy","count":0,"items":[]}"#
        })
        .bind(key)
        .execute(pool)
        .await?;

        Ok(())
    }
}
