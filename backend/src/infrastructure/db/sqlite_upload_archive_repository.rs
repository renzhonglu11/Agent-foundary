use sqlx::{Row, SqlitePool};

use crate::application::ports::upload_archive_repository::{
    LatestPdfText, UploadArchiveRepository, UploadedFileRecord,
};

#[derive(Debug, Clone)]
pub struct SqliteUploadArchiveRepository {
    pool: SqlitePool,
}

impl SqliteUploadArchiveRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait::async_trait]
impl UploadArchiveRepository for SqliteUploadArchiveRepository {
    async fn create_batch(&self, batch_id: &str, created_at: &str) -> anyhow::Result<()> {
        sqlx::query(
            r#"
            INSERT INTO upload_batches (batch_id, created_at)
            VALUES (?1, ?2)
            "#,
        )
        .bind(batch_id)
        .bind(created_at)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn insert_file(&self, record: &UploadedFileRecord) -> anyhow::Result<()> {
        sqlx::query(
            r#"
            INSERT INTO uploaded_files (
                file_id, batch_id, kind, original_filename, stored_path, size_bytes,
                imported_rows, extracted_text_path, extracted_text, created_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
        )
        .bind(&record.file_id)
        .bind(&record.batch_id)
        .bind(&record.kind)
        .bind(&record.original_filename)
        .bind(&record.stored_path)
        .bind(record.size_bytes)
        .bind(record.imported_rows)
        .bind(&record.extracted_text_path)
        .bind(&record.extracted_text)
        .bind(&record.created_at)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn latest_pdf_text(&self) -> anyhow::Result<Option<LatestPdfText>> {
        let Some(row) = sqlx::query(
            r#"
            SELECT stored_path, extracted_text, created_at
            FROM uploaded_files
            WHERE kind = 'pdf' AND extracted_text IS NOT NULL AND extracted_text <> ''
            ORDER BY created_at DESC, file_id DESC
            LIMIT 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };

        Ok(Some(LatestPdfText {
            stored_path: row.try_get("stored_path")?,
            extracted_text: row.try_get("extracted_text")?,
            created_at: row.try_get("created_at")?,
        }))
    }
}
