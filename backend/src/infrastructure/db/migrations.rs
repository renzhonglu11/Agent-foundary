use anyhow::Context;
use sqlx::{SqlitePool, migrate::Migrator};

/// Migrations are additive, so an older release may start on a schema that a
/// newer release already migrated; that is what makes release rollback work.
pub async fn run_migrations(pool: &SqlitePool) -> anyhow::Result<()> {
    let mut migrator: Migrator = sqlx::migrate!("./migrations");
    migrator.set_ignore_missing(true);
    migrator
        .run(pool)
        .await
        .context("failed to run sqlite migrations")
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    // Every release still on the VPS already contains these, including the one
    // destructive migration (20260621030000), so only later ones are checked.
    const LAST_UNCHECKED_VERSION: i64 = 20260907010000;

    #[test]
    fn new_migrations_are_additive() {
        let migrator: Migrator = sqlx::migrate!("./migrations");
        for migration in migrator
            .iter()
            .filter(|migration| migration.version > LAST_UNCHECKED_VERSION)
        {
            let sql = migration
                .sql
                .lines()
                .filter(|line| !line.trim_start().starts_with("--"))
                .flat_map(str::split_whitespace)
                .collect::<Vec<_>>()
                .join(" ")
                .to_uppercase();
            for forbidden in ["DROP TABLE", "DROP COLUMN", "RENAME"] {
                assert!(
                    !sql.contains(forbidden),
                    "migration {} uses {forbidden}; releases that can be rolled back to would break \
                     (see docs/deployment-runbook.md)",
                    migration.version
                );
            }
        }
    }

    #[tokio::test]
    async fn migrations_tolerate_versions_from_a_newer_release() -> anyhow::Result<()> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        run_migrations(&pool).await?;
        sqlx::query(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
             VALUES (99991231000000, 'from a newer release', 1, x'00', 0)",
        )
        .execute(&pool)
        .await?;

        run_migrations(&pool).await?;
        Ok(())
    }
}
