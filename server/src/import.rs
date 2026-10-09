//! `tasak import-jsonl FILE…`: imports into the archive the daily files of the old JavaScript archiver
//! (indexer/data/eventos/ and yadio/, kept locally). Each event is checked like the ones from the relays (author,
//! kind, id and signature) and keeps its relay and reception time; importing twice changes nothing.

use crate::store::{Store, Stored};
use nostr_sdk::prelude::*;
use serde::Deserialize;
use std::path::Path;

/// A line of eventos/*.jsonl or yadio/*.jsonl (Spanish keys: the format already written)
#[derive(Deserialize)]
struct Line {
    #[serde(rename = "recibido")]
    received: i64,
    relay: Option<String>,
    #[serde(rename = "evento")]
    event: Option<serde_json::Value>,
    url: Option<String>,
    #[serde(rename = "datos")]
    data: Option<serde_json::Value>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub new: usize,
    pub known: usize,
    pub unchanged: usize,
    pub rejected: usize,
    pub yadio: usize,
    pub invalid_lines: usize,
}

pub async fn import_file(store: &Store, path: &Path) -> Result<Counts, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    import_text(store, &text)
        .await
        .map_err(|e| format!("{}: {e}", path.display()))
}

pub async fn import_text(store: &Store, text: &str) -> Result<Counts, sqlx::Error> {
    let mut counts = Counts::default();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        // A line cut short by a power outage is counted, not fatal
        let Ok(line) = serde_json::from_str::<Line>(line) else {
            counts.invalid_lines += 1;
            continue;
        };
        match line {
            Line {
                relay: Some(relay),
                event: Some(event),
                ..
            } => {
                let Ok(event) = Event::from_json(event.to_string()) else {
                    counts.invalid_lines += 1;
                    continue;
                };
                match store.store(&relay, &event, line.received).await? {
                    Stored::New => counts.new += 1,
                    Stored::Known => counts.known += 1,
                    Stored::Unchanged => counts.unchanged += 1,
                    Stored::Rejected => counts.rejected += 1,
                }
            }
            Line {
                url: Some(url),
                data: Some(data),
                ..
            } => {
                if store.store_yadio(line.received, &url, &data.to_string()).await? {
                    counts.yadio += 1;
                }
            }
            _ => counts.invalid_lines += 1,
        }
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::tests::{memory_store, order};

    #[tokio::test]
    async fn imports_events_and_yadio_once() {
        let node = Keys::generate();
        let store = memory_store(&[node.public_key()]).await;
        let ev = order(&node, "o1", "success", 1000);
        let foreign = order(&Keys::generate(), "o2", "success", 1000);
        let line = |relay: &str, received: i64, ev: &Event| {
            format!(
                r#"{{"relay":"{relay}","recibido":{received},"evento":{}}}"#,
                ev.as_json()
            )
        };
        let text = [
            line("wss://a", 2000, &ev),
            line("wss://b", 2001, &ev),
            line("wss://a", 2000, &foreign),
            r#"{"recibido":3000,"url":"https://api.yadio.io/today/24/USD","datos":[{"price":1}]}"#.to_string(),
            r#"{"relay":"wss://a","recib"#.to_string(),
        ]
        .join("\n");
        let counts = import_text(&store, &text).await.unwrap();
        assert_eq!(
            counts,
            Counts {
                new: 1,
                known: 1,
                rejected: 1,
                yadio: 1,
                invalid_lines: 1,
                ..Counts::default()
            }
        );
        let received: i64 = sqlx::query_scalar("SELECT received FROM events")
            .fetch_one(store.pool())
            .await
            .unwrap();
        assert_eq!(received, 2000);
        let again = import_text(&store, &text).await.unwrap();
        assert_eq!(
            again,
            Counts {
                known: 2,
                rejected: 1,
                invalid_lines: 1,
                ..Counts::default()
            }
        );
    }
}
