//! One module per file of shared/, with the same functions (in snake_case) and the same rules. Numbers
//! are f64 like JavaScript's and every sum runs in the same order, so the results are the same bits.

pub mod js;
pub mod orders;
pub mod payment_methods;
pub mod rate;
pub mod rates;
pub mod time;
pub mod units;

use serde::Deserialize;

/// A Nostr event as JSON (NIP-01), already verified: the logic only reads it
#[derive(Debug, Clone, Deserialize)]
pub struct RawEvent {
    pub id: String,
    pub pubkey: String,
    pub created_at: i64,
    pub kind: u32,
    pub tags: Vec<Vec<String>>,
    #[serde(default)]
    pub content: String,
}

impl RawEvent {
    /// The values of the first tag named `name` (JavaScript: `tags.find(t => t[0] === name)?.slice(1)`)
    pub fn tag(&self, name: &str) -> Option<&[String]> {
        self.tags
            .iter()
            .find(|t| t.first().map(String::as_str) == Some(name))
            .map(|t| &t[1..])
    }
}
