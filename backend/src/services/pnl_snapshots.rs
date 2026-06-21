use std::{
    collections::{HashMap, hash_map::DefaultHasher},
    hash::{Hash, Hasher},
};

use anyhow::Context;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};

#[derive(Clone)]
pub struct PnlSnapshotService {
    pool: SqlitePool,
}

impl PnlSnapshotService {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn create_snapshot(
        &self,
        request: CreatePnlSnapshotRequest,
    ) -> anyhow::Result<PnlSnapshot> {
        let created_at = Utc::now().to_rfc3339();
        let id = format!(
            "pnl-{}",
            Utc::now()
                .timestamp_nanos_opt()
                .unwrap_or_else(|| Utc::now().timestamp_micros())
        );
        let records = request.records;
        let expiry_total = total_for_type(&records, "expiry");
        let drawdown_total = total_for_type(&records, "drawdown");
        let fingerprint = snapshot_fingerprint(&records);
        let record_count = i64::try_from(records.len()).unwrap_or(i64::MAX);

        let mut tx = self
            .pool
            .begin()
            .await
            .context("failed to start P&L snapshot transaction")?;

        let insert_result = sqlx::query(
            r#"
            INSERT INTO pnl_snapshots (
                id, created_at, expiry_total, drawdown_total, record_count, fingerprint
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(fingerprint) DO NOTHING
            "#,
        )
        .bind(&id)
        .bind(&created_at)
        .bind(expiry_total)
        .bind(drawdown_total)
        .bind(record_count)
        .bind(&fingerprint)
        .execute(&mut *tx)
        .await
        .context("failed to insert P&L snapshot")?;

        if insert_result.rows_affected() > 0 {
            insert_snapshot_records(&mut tx, &id, &records).await?;
        }

        tx.commit()
            .await
            .context("failed to commit P&L snapshot transaction")?;

        if let Some(existing) = self.find_snapshot_by_fingerprint(&fingerprint).await? {
            return Ok(existing);
        }

        Ok(PnlSnapshot {
            id,
            created_at,
            records,
            expiry_total,
            drawdown_total,
            record_count,
        })
    }

    pub async fn list_snapshots(&self) -> anyhow::Result<Vec<PnlSnapshot>> {
        let rows = sqlx::query(
            r#"
            SELECT id, created_at, expiry_total, drawdown_total, record_count
            FROM pnl_snapshots
            ORDER BY created_at DESC
            LIMIT 50
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to fetch P&L snapshots")?;

        let mut snapshots = rows
            .into_iter()
            .map(row_to_snapshot_header)
            .collect::<anyhow::Result<Vec<_>>>()?;
        let records_by_snapshot = load_records_for_snapshots(&self.pool, &snapshots).await?;

        for snapshot in &mut snapshots {
            snapshot.records = records_by_snapshot
                .get(&snapshot.id)
                .cloned()
                .unwrap_or_default();
        }

        Ok(snapshots)
    }

    pub async fn delete_snapshot(&self, id: &str) -> anyhow::Result<()> {
        let mut tx = self
            .pool
            .begin()
            .await
            .context("failed to start P&L snapshot delete transaction")?;

        sqlx::query("DELETE FROM pnl_snapshot_records WHERE snapshot_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .context("failed to delete P&L snapshot records")?;

        sqlx::query("DELETE FROM pnl_snapshots WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .context("failed to delete P&L snapshot")?;

        tx.commit()
            .await
            .context("failed to commit P&L snapshot delete transaction")?;

        Ok(())
    }

    async fn find_snapshot_by_fingerprint(
        &self,
        fingerprint: &str,
    ) -> anyhow::Result<Option<PnlSnapshot>> {
        let row = sqlx::query(
            r#"
            SELECT id, created_at, expiry_total, drawdown_total, record_count
            FROM pnl_snapshots
            WHERE fingerprint = ?
            "#,
        )
        .bind(fingerprint)
        .fetch_optional(&self.pool)
        .await
        .context("failed to fetch P&L snapshot by fingerprint")?;

        let Some(row) = row else {
            return Ok(None);
        };

        let mut snapshot = row_to_snapshot_header(row)?;
        snapshot.records = load_records_for_snapshot(&self.pool, &snapshot.id).await?;
        Ok(Some(snapshot))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePnlSnapshotRequest {
    pub records: Vec<PnlRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PnlRecord {
    pub id: String,
    #[serde(rename = "type")]
    pub record_type: String,
    pub product_name: String,
    pub pnl: f64,
    pub underlying_move_pct: Option<f64>,
    pub recorded_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PnlSnapshot {
    pub id: String,
    pub created_at: String,
    pub records: Vec<PnlRecord>,
    pub expiry_total: f64,
    pub drawdown_total: f64,
    pub record_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PnlSnapshotsResponse {
    pub snapshots: Vec<PnlSnapshot>,
}

fn total_for_type(records: &[PnlRecord], record_type: &str) -> f64 {
    records
        .iter()
        .filter(|record| record.record_type == record_type && record.pnl.is_finite())
        .map(|record| record.pnl)
        .sum()
}

async fn insert_snapshot_records(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    snapshot_id: &str,
    records: &[PnlRecord],
) -> anyhow::Result<()> {
    for (position, record) in records.iter().enumerate() {
        let position = i64::try_from(position).unwrap_or(i64::MAX);
        sqlx::query(
            r#"
            INSERT INTO pnl_snapshot_records (
                snapshot_id,
                record_id,
                record_type,
                product_name,
                pnl,
                underlying_move_pct,
                recorded_at,
                position
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(snapshot_id)
        .bind(&record.id)
        .bind(&record.record_type)
        .bind(&record.product_name)
        .bind(record.pnl)
        .bind(record.underlying_move_pct)
        .bind(record.recorded_at)
        .bind(position)
        .execute(&mut **tx)
        .await
        .context("failed to insert P&L snapshot record")?;
    }

    Ok(())
}

async fn load_records_for_snapshot(
    pool: &SqlitePool,
    snapshot_id: &str,
) -> anyhow::Result<Vec<PnlRecord>> {
    let rows = sqlx::query(
        r#"
        SELECT record_id, record_type, product_name, pnl, underlying_move_pct, recorded_at
        FROM pnl_snapshot_records
        WHERE snapshot_id = ?
        ORDER BY position ASC, id ASC
        "#,
    )
    .bind(snapshot_id)
    .fetch_all(pool)
    .await
    .context("failed to fetch P&L snapshot records")?;

    rows.into_iter().map(row_to_record).collect()
}

async fn load_records_for_snapshots(
    pool: &SqlitePool,
    snapshots: &[PnlSnapshot],
) -> anyhow::Result<HashMap<String, Vec<PnlRecord>>> {
    if snapshots.is_empty() {
        return Ok(HashMap::new());
    }

    let mut query_builder: QueryBuilder<'_, Sqlite> = QueryBuilder::new(
        r#"
        SELECT snapshot_id, record_id, record_type, product_name, pnl, underlying_move_pct, recorded_at
        FROM pnl_snapshot_records
        WHERE snapshot_id IN (
        "#,
    );

    let mut separated = query_builder.separated(", ");
    for snapshot in snapshots {
        separated.push_bind(&snapshot.id);
    }
    separated.push_unseparated(") ORDER BY snapshot_id, position ASC, id ASC");

    let rows = query_builder
        .build()
        .fetch_all(pool)
        .await
        .context("failed to fetch P&L snapshot records")?;

    let mut records_by_snapshot: HashMap<String, Vec<PnlRecord>> = HashMap::new();
    for row in rows {
        let snapshot_id: String = row.try_get("snapshot_id")?;
        records_by_snapshot
            .entry(snapshot_id)
            .or_default()
            .push(row_to_record(row)?);
    }

    Ok(records_by_snapshot)
}

fn row_to_snapshot_header(row: sqlx::sqlite::SqliteRow) -> anyhow::Result<PnlSnapshot> {
    Ok(PnlSnapshot {
        id: row.try_get("id")?,
        created_at: row.try_get("created_at")?,
        records: Vec::new(),
        expiry_total: row.try_get("expiry_total")?,
        drawdown_total: row.try_get("drawdown_total")?,
        record_count: row.try_get("record_count")?,
    })
}

fn row_to_record(row: sqlx::sqlite::SqliteRow) -> anyhow::Result<PnlRecord> {
    Ok(PnlRecord {
        id: row.try_get("record_id")?,
        record_type: row.try_get("record_type")?,
        product_name: row.try_get("product_name")?,
        pnl: row.try_get("pnl")?,
        underlying_move_pct: row.try_get("underlying_move_pct")?,
        recorded_at: row.try_get("recorded_at")?,
    })
}

fn snapshot_fingerprint(records: &[PnlRecord]) -> String {
    let mut parts: Vec<String> = records
        .iter()
        .map(|record| {
            format!(
                "{}|{}|{}|{:.6}|{}",
                record.id,
                record.record_type,
                record.product_name,
                record.pnl,
                record
                    .underlying_move_pct
                    .map(|value| format!("{value:.6}"))
                    .unwrap_or_else(|| "null".to_owned())
            )
        })
        .collect();
    parts.sort();

    let mut hasher = DefaultHasher::new();
    parts.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}
