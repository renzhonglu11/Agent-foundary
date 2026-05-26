use crate::domain::transaction::Transaction;

#[async_trait::async_trait]
pub trait TransactionRepository: Send + Sync {
    async fn replace_all(&self, transactions: &[Transaction]) -> anyhow::Result<()>;

    async fn list_all(&self) -> anyhow::Result<Vec<Transaction>>;
}
