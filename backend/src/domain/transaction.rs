use serde::{Deserialize, Serialize};

use crate::domain::money::Money;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Symbol(pub String);

impl Symbol {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AssetClass(pub String);

impl AssetClass {
    pub fn normalized(value: impl Into<String>) -> Self {
        let value = value.into();
        if value.is_empty() {
            Self("CASH".to_owned())
        } else {
            Self(value)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transaction {
    pub transaction_id: String,
    pub date: String,
    pub transaction_type: String,
    pub category: String,
    pub asset_class: AssetClass,
    pub name: String,
    pub symbol: Symbol,
    pub description: String,
    pub amount: Money,
    pub fee: Money,
    pub tax: Money,
    pub shares: f64,
    pub price: Money,
    pub currency: String,
}
