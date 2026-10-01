use std::path::Path;

use anyhow::Context;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode},
};
use tokio::fs;

pub async fn connect(database_url: &str) -> anyhow::Result<SqlitePool> {
    ensure_parent_dir(database_url).await?;

    let options = database_url
        .parse::<SqliteConnectOptions>()
        .context("DATABASE_URL must be a valid sqlite URL")?
        .create_if_missing(true)
        // Background monitor writes must not block API reads or the Python sidecar's reads.
        // WAL is persistent, so restores must also move the -wal/-shm files aside.
        .journal_mode(SqliteJournalMode::Wal);

    SqlitePool::connect_with(options)
        .await
        .context("failed to connect to sqlite database")
}

async fn ensure_parent_dir(database_url: &str) -> anyhow::Result<()> {
    let Some(path) = database_url.strip_prefix("sqlite://") else {
        return Ok(());
    };

    if path == ":memory:" {
        return Ok(());
    }

    if let Some(parent) = Path::new(path)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .await
            .with_context(|| format!("failed to create database directory {}", parent.display()))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn file_databases_use_wal() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let pool = connect(&format!("sqlite://{}", dir.path().join("app.db").display())).await?;
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await?;
        assert_eq!(mode, "wal");
        Ok(())
    }
}
