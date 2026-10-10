//! The archive: subscribes to the .env relays and stores (store.rs) everything the nodes publish, so
//! that the intermediate versions of each order (pending, in-progress) and the mostro-rates, which
//! relays replace or drop after 10 min, are not lost. Also keeps Yadio's BTC/USD of the last 24 h, to
//! fill the gaps when the archive was off.
//!
//! Each relay has its own task: a live subscription (to catch pending and in-progress before the relay
//! replaces them) and, every 5 min, a catch-up that pages its history back to a little before the last
//! one, which covers whatever the live subscription missed (disconnections, a lagging channel).

use crate::store::{META, ORDERS, RATES, RATES_D, Store, Stored};
use nostr_sdk::prelude::*;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, watch};
use tracing::{info, warn};

/// Events per query when paging history
const LIMIT: usize = 500;
/// A query that doesn't end (EOSE) in this time is abandoned
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);
/// How long to wait for the relays at start before subscribing to the ones that answered
const CONNECT_WAIT: Duration = Duration::from_secs(10);
const CATCH_UP_EVERY: Duration = Duration::from_secs(5 * 60);
/// After a restart, from an hour before the last event a relay sent
const RESTART_MARGIN: i64 = 3600;
/// Each catch-up overlaps the previous one by this much
const CATCH_UP_MARGIN: i64 = 15 * 60;
/// A relay unreachable for longer than this may have dropped mostro-rates: ask Yadio
const OUTAGE: Duration = Duration::from_secs(5 * 60);
const LIVE_ID: &str = "tasak-live";

const YADIO_URL: &str = "https://api.yadio.io/today/24/USD";
/// Two overlapping downloads a day cover the 24 h even if one fails
const YADIO_EVERY: Duration = Duration::from_secs(12 * 3600);
/// At most this often after an outage
const YADIO_MIN_GAP: Duration = Duration::from_secs(30 * 60);
const YADIO_TICK: Duration = Duration::from_secs(5 * 60);

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// Everything the nodes publish: every currency, every version. Filtering later is free; recovering
/// what was not stored is impossible
pub fn filters(nodes: &[PublicKey]) -> Vec<Filter> {
    let nodes = nodes.iter().copied();
    vec![
        Filter::new().kind(Kind::from_u16(ORDERS)).authors(nodes.clone()),
        Filter::new().kinds(META.map(Kind::from_u16)).authors(nodes.clone()),
        Filter::new()
            .kind(Kind::from_u16(RATES))
            .authors(nodes)
            .identifier(RATES_D),
    ]
}

/// Runs until the task is dropped
/// `caught_up` turns true once every relay's first catch-up has ended, well or not (a relay that doesn't
/// answer doesn't hold it back): what the relays had when tasak started is then in the archive
pub async fn run(store: Arc<Store>, nodes: Vec<PublicKey>, relays: Vec<String>, caught_up: watch::Sender<bool>) {
    let client = Client::default();
    let mut urls = Vec::new();
    for r in &relays {
        match RelayUrl::parse(r) {
            Ok(url) if urls.contains(&url) => {}
            Ok(url) => match client.add_relay(&url).await {
                Ok(_) => urls.push(url),
                Err(e) => warn!("{r}: {e}"),
            },
            Err(e) => warn!("{r}: {e}"),
        }
    }
    client.connect().and_wait(CONNECT_WAIT).await;
    info!("archive: {} node(s), {} relay(s)", nodes.len(), urls.len());

    let outage = Arc::new(AtomicBool::new(false));
    let filters = filters(&nodes);
    // Taken before any REQ: the stream only carries what arrives after it is opened
    let mut notifications = client.notifications();
    let (first_tx, mut first_rx) = mpsc::channel(urls.len().max(1));
    let relays_count = urls.len();
    for url in urls {
        tokio::spawn(relay_task(
            client.clone(),
            store.clone(),
            url,
            filters.clone(),
            outage.clone(),
            first_tx.clone(),
        ));
    }
    drop(first_tx);
    tokio::spawn(async move {
        for _ in 0..relays_count {
            if first_rx.recv().await.is_none() {
                break;
            }
        }
        info!("archive: first catch-up of every relay done");
        caught_up.send_replace(true);
    });
    tokio::spawn(yadio_task(store.clone(), outage));

    use futures::StreamExt as _;
    while let Some(n) = notifications.next().await {
        // Every message, not only the first time the pool sees an event: each relay that sends it counts
        let ClientNotification::Message { relay_url, message } = n else {
            continue;
        };
        let RelayMessage::Event { subscription_id, event } = *message else {
            continue;
        };
        if subscription_id.as_str() != LIVE_ID {
            continue;
        }
        match store.store(relay_url.as_str(), &event, now()).await {
            Ok(Stored::New) => info!("{relay_url}: new event kind {}", event.kind.as_u16()),
            Ok(_) => {}
            Err(e) => warn!("archive: cannot store an event: {e}"),
        }
    }
}

/// One relay: subscribe live (again until it works: the sdk forgets a subscription it could not send)
/// and catch up every few minutes. `first` is told when the first catch-up has ended, well or not
async fn relay_task(
    client: Client,
    store: Arc<Store>,
    url: RelayUrl,
    filters: Vec<Filter>,
    outage: Arc<AtomicBool>,
    first: mpsc::Sender<()>,
) {
    let mut first = Some(first);
    let mut first_done = || {
        if let Some(f) = first.take() {
            let _ = f.try_send(());
        }
    };
    let relay = url.to_string();
    let mut live = false;
    let mut last_ok: Option<i64> = None;
    let mut failing_since: Option<Instant> = None;
    loop {
        if !live {
            // Only new events: history comes from the catch-up. The sdk sends it again by itself when
            // the relay reconnects
            let since = Timestamp::from_secs((now() - 60).max(0) as u64);
            let live_filters: Vec<Filter> = filters.iter().map(|f| f.clone().since(since)).collect();
            // Ok even if the relay refused it: what counts is that this relay is among the successful
            let sent = client
                .subscribe(ReqTarget::single(&url, live_filters))
                .with_id(SubscriptionId::new(LIVE_ID))
                .await;
            live = sent.is_ok_and(|out| out.success.contains_key(&url));
        }
        let since = match last_ok {
            Some(t) => Some(t - CATCH_UP_MARGIN),
            None => match store.last_received(&relay).await {
                Ok(t) => t.map(|t| t - RESTART_MARGIN),
                Err(e) => {
                    warn!("archive: {e}");
                    first_done();
                    tokio::time::sleep(CATCH_UP_EVERY).await;
                    continue;
                }
            },
        };
        let started = now();
        match catch_up(&client, &store, &url, &filters, since).await {
            Ok(new) => {
                if let Some(t) = failing_since.take() {
                    info!("{relay}: answering again");
                    if t.elapsed() > OUTAGE {
                        outage.store(true, Ordering::Relaxed);
                    }
                }
                if last_ok.is_none() || new > 0 {
                    info!("{relay}: {new} new events from history");
                }
                last_ok = Some(started);
            }
            Err(e) => {
                if failing_since.is_none() {
                    warn!("{relay}: {e}");
                    failing_since = Some(Instant::now());
                }
            }
        }
        first_done();
        tokio::time::sleep(CATCH_UP_EVERY).await;
    }
}

/// Pages back each filter's history on one relay (from `since`, or everything it has), storing what is
/// new. Backwards with `until` until a batch brings nothing new: «fewer than the limit» is not enough,
/// some relays return fewer events than requested. Returns how many events were new
pub async fn catch_up(
    client: &Client,
    store: &Store,
    url: &RelayUrl,
    filters: &[Filter],
    since: Option<i64>,
) -> Result<usize, String> {
    let relay = url.to_string();
    // A query to a disconnected relay comes back empty, without an error: it would look caught up
    let status = client.relay(url).await.ok().flatten().map(|r| r.status());
    if !matches!(status, Some(RelayStatus::Connected | RelayStatus::Sleeping)) {
        return Err(format!(
            "not connected ({})",
            status.map_or("unknown".to_string(), |s| s.to_string())
        ));
    }
    let mut new = 0;
    for filter in filters {
        let mut seen = HashSet::new();
        let mut until: Option<u64> = None;
        loop {
            let mut f = filter.clone().limit(LIMIT);
            if let Some(s) = since {
                f = f.since(Timestamp::from_secs(s.max(0) as u64));
            }
            if let Some(u) = until {
                f = f.until(Timestamp::from_secs(u));
            }
            let started = Instant::now();
            let events: Vec<Event> = client
                .fetch_events(ReqTarget::single(url, [f]))
                .timeout(FETCH_TIMEOUT)
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .collect();
            // On timeout the sdk returns what arrived, which from a dead relay is nothing: not the end
            if events.is_empty() && started.elapsed() >= FETCH_TIMEOUT {
                return Err(format!("no answer in {} s", FETCH_TIMEOUT.as_secs()));
            }
            let fresh: Vec<&Event> = events.iter().filter(|e| seen.insert(e.id)).collect();
            if fresh.is_empty() {
                break;
            }
            let received = now();
            for ev in fresh {
                if store.store(&relay, ev, received).await.map_err(|e| e.to_string())? == Stored::New {
                    new += 1;
                }
            }
            // until is inclusive: if a whole batch shares one second, step back one so as not to get stuck
            let min = events.iter().map(|e| e.created_at.as_secs()).min().unwrap_or(0);
            if min == 0 {
                break;
            }
            until = Some(if until == Some(min) { min - 1 } else { min });
        }
    }
    Ok(new)
}

/// Yadio's BTC/USD every 5 min for the last 24 h: at start, every 12 h and after a relay outage
async fn yadio_task(store: Arc<Store>, outage: Arc<AtomicBool>) {
    let http = match reqwest::Client::builder().timeout(Duration::from_secs(30)).build() {
        Ok(c) => c,
        Err(e) => return warn!("yadio: {e}"),
    };
    let mut last_ok: Option<Instant> = None;
    let mut last_try: Option<Instant> = None;
    loop {
        let periodic = last_ok.is_none_or(|t| t.elapsed() >= YADIO_EVERY);
        let after_outage = outage.load(Ordering::Relaxed) && last_try.is_none_or(|t| t.elapsed() >= YADIO_MIN_GAP);
        if periodic || after_outage {
            outage.store(false, Ordering::Relaxed);
            last_try = Some(Instant::now());
            match fetch_yadio(&http, &store).await {
                Ok(n) => {
                    info!("yadio: {n} prices");
                    last_ok = Some(Instant::now());
                }
                Err(e) => warn!("yadio failed: {e}; retrying in 5 min"),
            }
        }
        tokio::time::sleep(YADIO_TICK).await;
    }
}

async fn fetch_yadio(http: &reqwest::Client, store: &Store) -> Result<usize, String> {
    let res = http.get(YADIO_URL).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let n = data.as_array().ok_or("unexpected response")?.len();
    store
        .store_yadio(now(), YADIO_URL, &data.to_string())
        .await
        .map_err(|e| e.to_string())?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::tests::{memory_store, order, rates};
    use nostr_sdk::local_relay::{LocalRelay, LocalRelayBuilder, RateLimit};

    async fn local_relay() -> LocalRelay {
        let relay = LocalRelayBuilder::default()
            .rate_limit(RateLimit {
                notes_per_minute: 10_000,
                ..RateLimit::default()
            })
            .build();
        relay.run().await.unwrap();
        relay
    }

    async fn publish(url: &RelayUrl, events: &[Event]) {
        let client = Client::default();
        client.add_relay(url).await.unwrap();
        client.connect().and_wait(Duration::from_secs(5)).await;
        for ev in events {
            client.send_event(ev).await.unwrap();
        }
        client.shutdown().await;
    }

    async fn count(store: &Store, sql: &'static str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(store.pool()).await.unwrap()
    }

    #[tokio::test]
    async fn catch_up_pages_back_through_the_whole_history() {
        let relay = local_relay().await;
        let url = relay.url().await;
        let node = Keys::generate();
        let other = Keys::generate();
        // More orders than one page, several in the same second, plus noise from another author
        let base = now() as u64 - 10_000;
        let mut events: Vec<Event> = (0..1200)
            .map(|i| order(&node, &format!("o{i}"), "success", base + i / 3))
            .collect();
        events.push(rates(&node, RATES_D, base));
        events.push(order(&other, "x", "success", base));
        publish(&url, &events).await;

        let store = memory_store(&[node.public_key()]).await;
        let client = Client::default();
        client.add_relay(&url).await.unwrap();
        client.connect().and_wait(Duration::from_secs(5)).await;
        let f = filters(&[node.public_key()]);
        assert_eq!(catch_up(&client, &store, &url, &f, None).await.unwrap(), 1201);
        assert_eq!(count(&store, "SELECT count(*) FROM events").await, 1201);
        // Again: nothing new, and nothing stored twice
        assert_eq!(catch_up(&client, &store, &url, &f, None).await.unwrap(), 0);
        // From a recent moment: only that part is asked for
        let later = order(&node, "late", "pending", now() as u64);
        publish(&url, &[later]).await;
        assert_eq!(catch_up(&client, &store, &url, &f, Some(now() - 60)).await.unwrap(), 1);
        assert_eq!(count(&store, "SELECT count(DISTINCT relay) FROM event_relays").await, 1);
        client.shutdown().await;
    }

    #[tokio::test]
    async fn an_unreachable_relay_is_an_error_not_an_empty_history() {
        let store = memory_store(&[]).await;
        let url = RelayUrl::parse("ws://127.0.0.1:1").unwrap();
        let client = Client::default();
        client.add_relay(&url).await.unwrap();
        client.connect().and_wait(Duration::from_secs(1)).await;
        assert!(catch_up(&client, &store, &url, &filters(&[]), None).await.is_err());
        client.shutdown().await;
    }

    #[tokio::test]
    async fn run_stores_history_and_live_events() {
        let relay = local_relay().await;
        let url = relay.url().await;
        let node = Keys::generate();
        let old = order(&node, "o1", "success", now() as u64 - 3600);
        publish(&url, &[old]).await;

        let store = Arc::new(memory_store(&[node.public_key()]).await);
        let (caught_up, mut caught_up_rx) = watch::channel(false);
        let task = tokio::spawn(run(
            store.clone(),
            vec![node.public_key()],
            vec![url.to_string()],
            caught_up,
        ));
        let wait_for = |n: i64| {
            let store = store.clone();
            async move {
                for _ in 0..100 {
                    if count(&store, "SELECT count(*) FROM events").await >= n {
                        return true;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                false
            }
        };
        // It says it caught up only once the history is stored
        tokio::time::timeout(Duration::from_secs(20), caught_up_rx.wait_for(|v| *v))
            .await
            .expect("caught up")
            .unwrap();
        assert_eq!(
            count(&store, "SELECT count(*) FROM events").await,
            1,
            "history before caught up"
        );
        // A pending that the relay replaces right away: only the live subscription sees it
        publish(
            &url,
            &[
                order(&node, "o2", "pending", now() as u64),
                rates(&node, RATES_D, now() as u64),
            ],
        )
        .await;
        assert!(wait_for(3).await, "live");
        task.abort();
    }

    #[tokio::test]
    async fn a_relay_that_doesnt_answer_doesnt_hold_back_the_catch_up() {
        let store = Arc::new(memory_store(&[]).await);
        let (caught_up, mut caught_up_rx) = watch::channel(false);
        let task = tokio::spawn(run(store, vec![], vec!["ws://127.0.0.1:1".to_string()], caught_up));
        tokio::time::timeout(Duration::from_secs(60), caught_up_rx.wait_for(|v| *v))
            .await
            .expect("caught up despite the relay")
            .unwrap();
        task.abort();
    }
}
