#[derive(Debug, Clone)]
pub struct UploadedFileRecord {
    pub file_id: String,
    pub batch_id: String,
    pub kind: String,
    pub original_filename: String,
    pub stored_path: String,
    pub size_bytes: i64,
    pub imported_rows: Option<i64>,
    pub extracted_text_path: Option<String>,
    pub extracted_text: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct LatestPdfText {
    pub stored_path: String,
    pub extracted_text: String,
    pub created_at: String,
}

#[async_trait::async_trait]
pub trait UploadArchiveRepository: Send + Sync {
    async fn create_batch(&self, batch_id: &str, created_at: &str) -> anyhow::Result<()>;

    async fn insert_file(&self, record: &UploadedFileRecord) -> anyhow::Result<()>;

    async fn latest_pdf_text(&self) -> anyhow::Result<Option<LatestPdfText>>;
}
