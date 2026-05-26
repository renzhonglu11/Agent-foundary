use sqlx::{Row, SqlitePool};

use crate::{
    application::ports::transaction_repository::TransactionRepository,
    domain::{
        money::Money,
        transaction::{AssetClass, Symbol, Transaction},
    },
};

#[derive(Debug, Clone)]
pub struct SqliteTransactionRepository {
    pool: SqlitePool,
}

impl SqliteTransactionRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait::async_trait]
impl TransactionRepository for SqliteTransactionRepository {
    async fn replace_all(&self, transactions: &[Transaction]) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM transactions")
            .execute(&mut *tx)
            .await?;

        for item in transactions {
            sqlx::query(
                r#"
                INSERT INTO transactions (
                    transaction_id, date, type, category, asset_class, name, symbol, description,
                    amount, fee, tax, shares, price, currency
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                "#,
            )
            .bind(&item.transaction_id)
            .bind(&item.date)
            .bind(&item.transaction_type)
            .bind(&item.category)
            .bind(&item.asset_class.0)
            .bind(&item.name)
            .bind(&item.symbol.0)
            .bind(&item.description)
            .bind(item.amount.amount())
            .bind(item.fee.amount())
            .bind(item.tax.amount())
            .bind(item.shares)
            .bind(item.price.amount())
            .bind(&item.currency)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    async fn list_all(&self) -> anyhow::Result<Vec<Transaction>> {
        let rows = sqlx::query(
            r#"
            SELECT transaction_id, date, type, category, asset_class, name, symbol, description,
                   amount, fee, tax, shares, price, currency
            FROM transactions
            ORDER BY date ASC, transaction_id ASC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        let transactions = rows
            .into_iter()
            .map(|row| {
                Ok(Transaction {
                    transaction_id: row.try_get("transaction_id")?,
                    date: row.try_get("date")?,
                    transaction_type: row.try_get("type")?,
                    category: row.try_get("category")?,
                    asset_class: AssetClass(row.try_get("asset_class")?),
                    name: row.try_get("name")?,
                    symbol: Symbol(row.try_get("symbol")?),
                    description: row.try_get("description")?,
                    amount: Money(row.try_get("amount")?),
                    fee: Money(row.try_get("fee")?),
                    tax: Money(row.try_get("tax")?),
                    shares: row.try_get("shares")?,
                    price: Money(row.try_get("price")?),
                    currency: row.try_get("currency")?,
                })
            })
            .collect::<Result<Vec<_>, sqlx::Error>>()?;

        Ok(transactions)
    }
}
