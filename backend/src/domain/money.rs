use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Serialize, Deserialize, Default)]
#[serde(transparent)]
pub struct Money(pub f64);

impl Money {
    pub fn zero() -> Self {
        Self(0.0)
    }

    pub fn amount(self) -> f64 {
        self.0
    }
}
