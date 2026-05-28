use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool};

use crate::application::ports::market_data_repository::{MarketDataRepository, MarketQuoteRecord};

#[derive(Debug, Clone)]
pub struct SqliteMarketDataRepository {
    pool: SqlitePool,
}

impl SqliteMarketDataRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
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
        let Some(row) = sqlx::query(
            r#"
            SELECT payload_json
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

        Ok(Some(row.try_get("payload_json")?))
    }

    async fn store_payload(
        &self,
        key: &str,
        payload_json: &str,
        updated_at: &str,
    ) -> anyhow::Result<()> {
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
        .execute(&self.pool)
        .await?;

        Ok(())
    }
}
