use std::path::Path;

use anyhow::Context;
use sqlx::{SqlitePool, sqlite::SqliteConnectOptions};
use tokio::fs;

pub async fn connect(database_url: &str) -> anyhow::Result<SqlitePool> {
    ensure_parent_dir(database_url).await?;

    let options = database_url
        .parse::<SqliteConnectOptions>()
        .context("DATABASE_URL must be a valid sqlite URL")?
        .create_if_missing(true);

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
