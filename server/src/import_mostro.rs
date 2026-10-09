//! `tasak import-mostro FILE [NODE]`: imports into `node_orders` the completed orders of a copy of the
//! node's Mostro database, to recover the history the relays have already deleted (~15 days). Run it
//! on a COPY (`sqlite3 mostro.db ".backup mostro-copy.db"`), opened read only.
//!
//! Only public trade data is read, with an explicit list of columns: never the buyers' or sellers'
//! keys, invoices, preimages, Cashu tokens or the users table. A database of an older version may lack
//! some column: it comes as NULL.
//!
//! What the database has (Mostro 0.19): one row per order, overwritten in place (no history, no
//! signature, no BTC price, no completion time); fiat_amount and amount of a completed order are the
//! fa and amt of its success event, and event_id is that event; price_from_api = 1 is market price;
//! taken_at lies between the take and the escrow lock (invoice_held_at); each completed slice of a
//! range order is its own row.

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::collections::HashSet;
use std::path::Path;

/// A UUID column as the d tag of the events writes it: Mostro keeps it as a 16-byte BLOB
macro_rules! uuid {
    ($c:literal) => {
        concat!(
            "CASE WHEN typeof(",
            $c,
            ") = 'blob' AND length(",
            $c,
            ") = 16 THEN lower(substr(hex(",
            $c,
            "), 1, 8) || '-' || ",
            "substr(hex(",
            $c,
            "), 9, 4) || '-' || substr(hex(",
            $c,
            "), 13, 4) || '-' || substr(hex(",
            $c,
            "), 17, 4) || '-' || ",
            "substr(hex(",
            $c,
            "), 21)) ELSE NULLIF(CAST(",
            $c,
            " AS TEXT), '') END"
        )
    };
}

/// Columns read, with the expression that normalizes each one (0 or '' mean «not set»)
const COLUMNS: [(&str, &str, &str); 14] = [
    ("id", uuid!("id"), "NULL"),
    ("event_id", "NULLIF(event_id, '')", "NULL"),
    ("kind", "lower(kind)", "NULL"),
    ("status", "status", "NULL"),
    ("fiat_code", "upper(fiat_code)", "NULL"),
    ("fiat_amount", "CAST(fiat_amount AS REAL)", "NULL"),
    ("amount", "CAST(amount AS REAL)", "NULL"),
    ("premium", "CAST(coalesce(premium, 0) AS REAL)", "0.0"),
    ("price_from_api", "price_from_api", "NULL"),
    ("payment_method", "coalesce(payment_method, '')", "''"),
    ("created_at", "created_at", "0"),
    ("taken_at", "NULLIF(taken_at, 0)", "NULL"),
    ("invoice_held_at", "NULLIF(invoice_held_at, 0)", "NULL"),
    ("range_parent_id", uuid!("range_parent_id"), "NULL"),
];
/// Without these there is no order to import
const REQUIRED: [&str; 6] = ["id", "kind", "status", "fiat_code", "fiat_amount", "amount"];
/// Executed in the node but not `success`, so they don't count (the rule of the Tasa K): only counted
const NOT_SUCCESS: [&str; 3] = ["settled-hold-invoice", "completed-by-admin", "settled-by-admin"];

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Imported {
    /// Completed orders (success) written to node_orders
    pub success: usize,
    /// Executed orders of other statuses, not imported: (status, how many)
    pub other: Vec<(String, i64)>,
    /// Columns this database lacks (read as NULL)
    pub missing: Vec<String>,
}

/// Imports the completed orders of `file` (a copy of a Mostro database) as orders of `node`
pub async fn import(archive: &SqlitePool, file: &Path, node: &str, now: i64) -> Result<Imported, String> {
    if !file.is_file() {
        return Err(format!("{}: no such file", file.display()));
    }
    let options = SqliteConnectOptions::new().filename(file).read_only(true);
    let source = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| format!("cannot open {}: {e}", file.display()))?;
    let result = read_and_store(&source, archive, node, now).await;
    source.close().await;
    result.map_err(|e| format!("{}: {e}", file.display()))
}

async fn read_and_store(source: &SqlitePool, archive: &SqlitePool, node: &str, now: i64) -> Result<Imported, String> {
    let existing: HashSet<String> = sqlx::query("PRAGMA table_info(orders)")
        .fetch_all(source)
        .await
        .map_err(|e| e.to_string())?
        .iter()
        .filter_map(|r| r.try_get::<String, _>("name").ok())
        .collect();
    if existing.is_empty() {
        return Err("no orders table: is it a Mostro database?".into());
    }
    if let Some(c) = REQUIRED.iter().find(|c| !existing.contains(**c)) {
        return Err(format!("its orders table has no {c} column: is it a Mostro database?"));
    }
    let select: Vec<String> = COLUMNS
        .iter()
        .map(|(name, expr, default)| {
            if existing.contains(*name) {
                format!("{expr} AS {name}")
            } else {
                format!("{default} AS {name}")
            }
        })
        .collect();
    // Built only from the constants above, never from the database's contents
    let sql = format!(
        "SELECT {} FROM orders WHERE status = 'success' ORDER BY created_at, id",
        select.join(", ")
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .fetch_all(source)
        .await
        .map_err(|e| e.to_string())?;

    let mut tx = archive.begin().await.map_err(|e| e.to_string())?;
    for r in &rows {
        sqlx::query(
            "INSERT OR REPLACE INTO node_orders (node, id, event_id, kind, status, fiat_code, fiat_amount, amount, \
             premium, price_from_api, payment_method, created_at, taken_at, invoice_held_at, range_parent_id, imported) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(node)
        .bind(r.try_get::<String, _>("id").map_err(|e| e.to_string())?)
        .bind(r.try_get::<Option<String>, _>("event_id").map_err(|e| e.to_string())?)
        .bind(r.try_get::<String, _>("kind").map_err(|e| e.to_string())?)
        .bind(r.try_get::<String, _>("status").map_err(|e| e.to_string())?)
        .bind(r.try_get::<String, _>("fiat_code").map_err(|e| e.to_string())?)
        .bind(r.try_get::<f64, _>("fiat_amount").map_err(|e| e.to_string())?)
        .bind(r.try_get::<f64, _>("amount").map_err(|e| e.to_string())?)
        .bind(r.try_get::<f64, _>("premium").map_err(|e| e.to_string())?)
        .bind(r.try_get::<Option<bool>, _>("price_from_api").map_err(|e| e.to_string())?)
        .bind(r.try_get::<String, _>("payment_method").map_err(|e| e.to_string())?)
        .bind(r.try_get::<i64, _>("created_at").map_err(|e| e.to_string())?)
        .bind(r.try_get::<Option<i64>, _>("taken_at").map_err(|e| e.to_string())?)
        .bind(r.try_get::<Option<i64>, _>("invoice_held_at").map_err(|e| e.to_string())?)
        .bind(r.try_get::<Option<String>, _>("range_parent_id").map_err(|e| e.to_string())?)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;

    let other: Vec<(String, i64)> =
        sqlx::query_as("SELECT status, count(*) FROM orders WHERE status IN (?, ?, ?) GROUP BY status ORDER BY status")
            .bind(NOT_SUCCESS[0])
            .bind(NOT_SUCCESS[1])
            .bind(NOT_SUCCESS[2])
            .fetch_all(source)
            .await
            .map_err(|e| e.to_string())?;
    let missing = COLUMNS
        .iter()
        .map(|c| c.0)
        .filter(|c| !existing.contains(*c))
        .map(String::from)
        .collect();
    Ok(Imported {
        success: rows.len(),
        other,
        missing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orders::tests::{lists, version};
    use crate::orders::{Cursor, sync};
    use crate::store::tests::memory_store;
    use nostr_sdk::prelude::*;
    use std::path::PathBuf;

    /// A small Mostro-like database in a temporary file: the private columns are there, filled, to
    /// check they are never read
    async fn mostro_db(name: &str, with_price_from_api: bool) -> PathBuf {
        let path = std::env::temp_dir().join(format!("tasak-test-{name}-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let pool = SqlitePoolOptions::new()
            .connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true))
            .await
            .unwrap();
        let pfa = if with_price_from_api {
            "price_from_api integer not null default 0,"
        } else {
            ""
        };
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "CREATE TABLE orders (id char(36) primary key, kind varchar(4) not null, event_id char(64) not null,
             preimage char(64), buyer_pubkey char(64), master_buyer_pubkey char(64), buyer_invoice text,
             status varchar(10) not null, {pfa} premium integer not null, payment_method varchar(500) not null,
             amount integer not null, fiat_code varchar(5) not null, fiat_amount integer not null,
             range_parent_id char(36), invoice_held_at integer default 0, taken_at integer default 0,
             created_at integer not null)"
        )))
        .execute(&pool)
        .await
        .unwrap();
        let cols = if with_price_from_api { "price_from_api," } else { "" };
        let pfa_value = |v: i64| {
            if with_price_from_api {
                format!("{v},")
            } else {
                String::new()
            }
        };
        // Mostro keeps the ids as 16-byte BLOBs
        for (id, status, market, pm, amount, fiat, taken, held) in [
            (O1, "success", 1, "Transfermovil, EnZona", 5000, 1000, 1100, 1150),
            (O2, "success", 0, "llamar al +53 5555", 6000, 1000, 0, 0),
            (
                "33333333-3333-4333-8333-333333333333",
                "canceled",
                1,
                "EnZona",
                5000,
                1000,
                0,
                0,
            ),
            (
                "44444444-4444-4444-8444-444444444444",
                "settled-hold-invoice",
                1,
                "EnZona",
                5000,
                1000,
                1200,
                1250,
            ),
        ] {
            let blob = id.replace('-', "");
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "INSERT INTO orders (id, kind, event_id, preimage, buyer_pubkey, master_buyer_pubkey, buyer_invoice, status,
                 {cols} premium, payment_method, amount, fiat_code, fiat_amount, invoice_held_at, taken_at, created_at)
                 VALUES (X'{blob}', 'sell', 'ev-{id}', 'secret', 'buyer', 'master', 'lnbc1', '{status}', {} 3, '{pm}', {amount},
                 'cup', {fiat}, {held}, {taken}, 1000)",
                pfa_value(market)
            )))
            .execute(&pool)
            .await
            .unwrap();
        }
        pool.close().await;
        path
    }

    const O1: &str = "11111111-1111-4111-8111-111111111111";
    const O2: &str = "22222222-2222-4222-8222-222222222222";

    type Row = (String, String, i64, Option<i64>, i64, Option<i64>, i64, String);

    async fn orders(pool: &SqlitePool) -> Vec<Row> {
        sqlx::query_as(
            "SELECT substr(key, 66), id, ts, taken_at, priced_at, origin_fixed, signed, pm_keys FROM orders ORDER BY key",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn imports_only_completed_orders_and_merges_them_with_the_signed_events() {
        let node = Keys::generate();
        let store = memory_store(&[node.public_key()]).await;
        let pk = node.public_key().to_hex();
        // o1 is also archived as a signed success event, without its pending or in-progress versions
        let signed = version(&node, O1, "success", 1300, "5000", "3");
        store.store("wss://a", &signed, 1).await.unwrap();
        let file = mostro_db("import", true).await;
        let imported = import(store.pool(), &file, &pk, 9999).await.unwrap();
        assert_eq!(
            imported,
            Imported {
                success: 2,
                other: vec![("settled-hold-invoice".into(), 1)],
                missing: vec![]
            }
        );
        sync(store.pool(), &lists(), Cursor::default()).await.unwrap();
        let pm2 = r#"["Otros"]"#.to_string();
        assert_eq!(
            orders(store.pool()).await,
            vec![
                // Signed: the event's id and completion time; the take time and the market price from the database
                (
                    O1.into(),
                    signed.id.to_hex(),
                    1300,
                    Some(1100),
                    1100,
                    Some(0),
                    1,
                    r#"["Transfermovil","Otros"]"#.into()
                ),
                // Only in the database: unsigned, completed ≈ the escrow lock or, without it, created; fixed price
                (O2.into(), format!("ev-{O2}"), 1000, None, 1000, Some(1), 0, pm2),
            ]
        );
        // Importing again changes nothing in `orders`
        let before = orders(store.pool()).await;
        import(store.pool(), &file, &pk, 10000).await.unwrap();
        sync(store.pool(), &lists(), Cursor::default()).await.unwrap();
        assert_eq!(orders(store.pool()).await, before);
        // Never a private column: node_orders has no place for them
        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('node_orders')")
            .fetch_all(store.pool())
            .await
            .unwrap();
        for private in ["preimage", "buyer_pubkey", "master_buyer_pubkey", "buyer_invoice"] {
            assert!(!columns.contains(&private.to_string()));
        }
        let _ = std::fs::remove_file(file);
    }

    #[tokio::test]
    async fn an_older_database_without_some_columns() {
        let node = Keys::generate();
        let store = memory_store(&[node.public_key()]).await;
        let file = mostro_db("old", false).await;
        let imported = import(store.pool(), &file, &node.public_key().to_hex(), 1)
            .await
            .unwrap();
        assert_eq!(imported.success, 2);
        assert_eq!(imported.missing, vec!["price_from_api".to_string()]);
        sync(store.pool(), &lists(), Cursor::default()).await.unwrap();
        // Without price_from_api: market or fixed is unknown
        assert!(orders(store.pool()).await.iter().all(|r| r.5.is_none()));
        let _ = std::fs::remove_file(file);
    }

    #[tokio::test]
    async fn not_a_mostro_database() {
        let store = memory_store(&[]).await;
        let path = std::env::temp_dir().join(format!("tasak-test-empty-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        SqlitePoolOptions::new()
            .connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true))
            .await
            .unwrap()
            .close()
            .await;
        let err = import(store.pool(), &path, "n", 1).await.unwrap_err();
        assert!(err.contains("no orders table"), "{err}");
        assert!(
            import(store.pool(), Path::new("/nonexistent/x.db"), "n", 1)
                .await
                .is_err()
        );
        let _ = std::fs::remove_file(path);
    }
}
