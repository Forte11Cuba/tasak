//! The Rust logic against the same vectors as shared/ (JavaScript): shared/test/expected.json (frozen
//! from the site before the restructuring) and cases.json (hand-written). One test per test of
//! shared/test/*.test.js; numbers must be the same bits, not merely close.

use chrono_tz::Tz;
use serde_json::{Value, json};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::LazyLock;
use tasak::logic::RawEvent;
use tasak::logic::orders::{
    Book, Filters, Order, Trade, current_order, get_book, get_trades, most_used_fiat, newer_version, parse_order,
    priced_at,
};
use tasak::logic::payment_methods::{
    PmLists, default_pm_selection, hidden_set, norm_pm, order_matches_pm, pm_key, pm_list_for, pm_stats,
};
use tasak::logic::rate::{build_candles, chart_points, moving_weighted, rate_breakdown, tasa_k, weighted_price};
use tasak::logic::rates::{Market, Rates, current_rates, fiat_per_usd, market_price, parse_rates};
use tasak::logic::time::{TIMEFRAMES, empty_periods, next_period, period_start, to_chart_time, tz_offset};
use tasak::logic::units::{Unit, hourly_close, to_unit};

fn path(p: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(p)
}

fn read_json(p: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path(p)).unwrap()).unwrap()
}

struct Data {
    expected: Value,
    cases: Value,
    hidden: Vec<String>,
    now: f64,
    tz: Tz,
    nodes: HashSet<String>,
    events: Vec<RawEvent>,
    btcusd: HashMap<i64, f64>,
    yadio_btc: f64,
    yadio_usd: HashMap<String, f64>,
    lists: PmLists,
}

static DATA: LazyLock<Data> = LazyLock::new(|| {
    let expected = read_json("shared/test/expected.json");
    let config = read_json("shared/test/fixtures/config.json");
    let yadio = read_json("shared/test/fixtures/yadio.json");
    // A classic script that sets window.MOSTRO_PAYMENT_METHODS = {...}: the object is JSON
    let script = std::fs::read_to_string(path("web/vendor/mostro-payment-methods.js")).unwrap();
    let object = &script[script.find('{').unwrap()..=script.rfind('}').unwrap()];
    Data {
        now: expected["now"].as_f64().unwrap(),
        expected,
        cases: read_json("shared/test/cases.json"),
        hidden: serde_json::from_value(config["hiddenPaymentMethods"].clone()).unwrap(),
        tz: config["timeZone"].as_str().unwrap().parse().unwrap(),
        nodes: serde_json::from_value(config["mostros"].clone()).unwrap(),
        events: serde_json::from_value(read_json("shared/test/fixtures/events.json")).unwrap(),
        btcusd: read_json("shared/test/fixtures/btcusd.json")
            .as_object()
            .unwrap()
            .iter()
            .map(|(t, c)| (t.parse().unwrap(), c.as_f64().unwrap()))
            .collect(),
        yadio_btc: yadio["BTC"].as_f64().unwrap(),
        yadio_usd: serde_json::from_value(yadio["USD"].clone()).unwrap(),
        lists: serde_json::from_str(object).unwrap(),
    }
});

/// Deep equality with numbers compared as f64 (1000 and 1000.0 are the same number in JavaScript)
fn same(actual: &Value, want: &Value, at: &str) -> Result<(), String> {
    let differ = || Err(format!("{at}: got {actual}, expected {want}"));
    match (actual, want) {
        (Value::Number(a), Value::Number(b)) if a.as_f64() == b.as_f64() => Ok(()),
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => a
            .iter()
            .zip(b)
            .enumerate()
            .try_for_each(|(i, (x, y))| same(x, y, &format!("{at}[{i}]"))),
        (Value::Object(a), Value::Object(b)) if a.len() == b.len() => b
            .iter()
            .try_for_each(|(k, y)| a.get(k).map_or_else(differ, |x| same(x, y, &format!("{at}.{k}")))),
        (a, b) if !a.is_number() && a == b => Ok(()),
        _ => differ(),
    }
}

#[track_caller]
fn check(actual: Value, want: &Value, what: &str) {
    if let Err(e) = same(&actual, want, what) {
        panic!("{e}");
    }
}

/// Orders as the site keeps them: every version of each order, deduplicated by id, and its current state
fn load_orders() -> Vec<Order> {
    let d = &*DATA;
    let mut seen = HashSet::new();
    let mut keys: Vec<String> = Vec::new();
    let mut versions: HashMap<String, Vec<Order>> = HashMap::new();
    for ev in &d.events {
        if ev.kind != 38383 || !d.nodes.contains(&ev.pubkey) || !seen.insert(ev.id.clone()) {
            continue;
        }
        let Some(o) = parse_order(ev, &d.lists) else { continue };
        if !versions.contains_key(&o.key) {
            keys.push(o.key.clone());
        }
        versions.entry(o.key.clone()).or_default().push(o);
    }
    keys.iter().map(|k| current_order(&versions[k]).unwrap()).collect()
}

struct View {
    trades: Vec<Trade>,
    book: Book,
    approx: bool,
}

/// What the site shows for a currency and unit with the default payment methods
fn view_of(orders: &[Order], fiat: &str, unit: Unit) -> View {
    let d = &*DATA;
    let keys: Vec<String> = pm_stats(orders, fiat, &d.nodes, d.now)
        .into_iter()
        .map(|s| s.key)
        .collect();
    let filters = Filters {
        fiat: fiat.to_string(),
        nodes: d.nodes.clone(),
        pm_sel: default_pm_selection(&keys, &hidden_set(&d.hidden)),
    };
    // BTC/USD of the moment each order was taken (or completed): the hourly Coinbase close; without
    // it, Yadio's current price (approximate)
    let approx = Cell::new(false);
    let btc_at = |ts: i64| {
        hourly_close(&d.btcusd, ts).or_else(|| {
            if (ts as f64) < d.now - 3.0 * 3600.0 {
                approx.set(true);
            }
            Some(d.yadio_btc)
        })
    };
    let trades = get_trades(orders, &filters, |p, o| to_unit(p, unit, btc_at(priced_at(o))));
    let reference = d.yadio_usd.get(fiat).copied().or((fiat == "USD").then_some(1.0));
    let market = |_: &str| {
        reference.map(|r| Market {
            fiat_per_btc: r * d.yadio_btc,
            from: "api".into(),
            expired: false,
            source: None,
        })
    };
    let book = get_book(orders, &filters, d.now, market, |p| to_unit(p, unit, Some(d.yadio_btc)));
    View {
        trades,
        book,
        approx: approx.get(),
    }
}

/// Every currency and unit of expected.json: (name, its expected values, the view)
fn views() -> Vec<(String, Value, View)> {
    let orders = load_orders();
    let mut out = Vec::new();
    for (fiat, c) in DATA.expected["currencies"].as_object().unwrap() {
        for (unit, u) in c["units"].as_object().unwrap() {
            out.push((
                format!("{fiat}/{unit}"),
                u.clone(),
                view_of(&orders, fiat, Unit::parse(unit).unwrap()),
            ));
        }
    }
    out
}

fn tf_name(tf: f64) -> String {
    (tf as i64).to_string()
}

// ---------- orders.test.js ----------

#[test]
fn chosen_version_and_fields_of_every_order() {
    let mut orders = load_orders();
    orders.sort_by(|a, b| a.key.cmp(&b.key));
    let fields: Vec<Value> = orders
        .iter()
        .map(|o| {
            json!({ "key": o.key, "id": o.id, "ts": o.ts, "status": o.status, "side": o.side, "fiat": o.fiat,
                "fa": o.fa, "amt": o.amt, "premium": o.premium, "expiresAt": o.expires_at, "pm": o.pm,
                "pmKeys": o.pm_keys, "origin": o.origin })
        })
        .collect();
    check(Value::Array(fields), &DATA.expected["orders"], "orders");
}

#[test]
fn parsing_an_order_event() {
    for c in DATA.cases["parseOrder"].as_array().unwrap() {
        let ev: RawEvent = serde_json::from_value(c["event"].clone()).unwrap();
        let got = parse_order(&ev, &DATA.lists).map(|o| {
            json!({ "key": o.key, "node": o.node, "nodeName": o.node_name, "id": o.id, "ts": o.ts, "status": o.status,
                "side": o.side, "fiat": o.fiat, "fa": o.fa, "amt": o.amt, "premium": o.premium, "expiresAt": o.expires_at,
                "pm": o.pm, "pmKeys": o.pm_keys })
        });
        check(json!(got), &c["expected"], c["note"].as_str().unwrap());
    }
}

fn version(v: &Value) -> Order {
    let mut o = blank_order(v[2].as_str().unwrap());
    o.ts = v[0].as_i64().unwrap();
    o.status = v[1].as_str().unwrap().to_string();
    o
}

fn blank_order(id: &str) -> Order {
    Order {
        key: id.to_string(),
        node: String::new(),
        node_name: None,
        id: id.to_string(),
        ts: 0,
        status: String::new(),
        side: String::new(),
        fiat: String::new(),
        fa: vec![],
        amt: 0.0,
        premium: 0.0,
        expires_at: 0.0,
        pm: vec![],
        pm_keys: vec![],
        origin: None,
        taken_at: None,
    }
}

#[test]
fn tie_break_between_versions_of_an_order() {
    for c in DATA.expected["cases"]["versions"].as_array().unwrap() {
        assert_eq!(
            newer_version(&version(&c["a"]), &version(&c["b"])),
            c["wins"].as_bool().unwrap(),
            "{c}"
        );
    }
}

fn permutations<T: Clone>(a: &[T]) -> Vec<Vec<T>> {
    if a.len() < 2 {
        return vec![a.to_vec()];
    }
    (0..a.len())
        .flat_map(|i| {
            let mut rest = a.to_vec();
            let x = rest.remove(i);
            permutations(&rest).into_iter().map(move |mut p| {
                p.insert(0, x.clone());
                p
            })
        })
        .collect()
}

#[test]
fn current_state_of_an_order_in_any_arrival_order() {
    for c in DATA.cases["orderVersions"].as_array().unwrap() {
        let parsed: Vec<Order> = c["versions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| {
                let mut o = version(v);
                o.amt = v[3].as_f64().unwrap();
                o.premium = v[4].as_f64().unwrap();
                o
            })
            .collect();
        for arrival in permutations(&parsed) {
            let o = current_order(&arrival).unwrap();
            let ids: Vec<&str> = arrival.iter().map(|v| v.id.as_str()).collect();
            check(
                json!({ "id": o.id, "origin": o.origin, "takenAt": o.taken_at }),
                &c["expected"],
                &format!("{}: {ids:?}", c["note"]),
            );
        }
    }
}

#[test]
fn usd_at_the_moment_each_order_was_taken() {
    let c = &DATA.cases["usdPerOrder"];
    let btc_usd: HashMap<String, f64> = serde_json::from_value(c["btcUsd"].clone()).unwrap();
    let orders: Vec<Order> = c["orders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| Order {
            ts: o["ts"].as_i64().unwrap(),
            taken_at: o["takenAt"].as_i64(),
            fa: serde_json::from_value(o["fa"].clone()).unwrap(),
            amt: o["amt"].as_f64().unwrap(),
            node: "n1".into(),
            status: "success".into(),
            fiat: "CUP".into(),
            pm_keys: vec!["X".into()],
            ..blank_order(o["id"].as_str().unwrap())
        })
        .collect();
    let filters = Filters {
        fiat: "CUP".into(),
        nodes: HashSet::from(["n1".to_string()]),
        pm_sel: HashSet::from(["X".to_string()]),
    };
    let trades = get_trades(&orders, &filters, |p, o| {
        btc_usd.get(&priced_at(o).to_string()).map(|b| p / b)
    });
    let rows: Vec<Value> = trades.iter().map(|t| json!([t.key, t.price])).collect();
    check(Value::Array(rows), &c["expected"], c["note"].as_str().unwrap());
}

#[test]
fn currency_chosen_without_fiat() {
    assert_eq!(
        most_used_fiat(&load_orders()).as_deref(),
        DATA.expected["view"]["fiat"].as_str()
    );
    assert_eq!(most_used_fiat(&[]), None);
}

#[test]
fn order_book_per_currency_and_unit() {
    let row = |o: &tasak::logic::orders::BookOrder| json!({ "key": o.key, "price": o.price, "size": o.size, "fixed": o.fixed });
    for (name, u, v) in views() {
        let got = json!({ "asks": v.book.asks.iter().map(row).collect::<Vec<_>>(), "bids": v.book.bids.iter().map(row).collect::<Vec<_>>() });
        check(got, &u["book"], &name);
    }
}

#[test]
fn order_book_with_the_market_price_of_each_node() {
    let c = &DATA.cases["bookPerNode"];
    let market: HashMap<String, Option<Market>> = serde_json::from_value(c["market"].clone()).unwrap();
    let orders: Vec<Order> = c["orders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| Order {
            node: o["node"].as_str().unwrap().into(),
            side: o["side"].as_str().unwrap().into(),
            fa: serde_json::from_value(o["fa"].clone()).unwrap(),
            amt: o["amt"].as_f64().unwrap(),
            premium: o["premium"].as_f64().unwrap(),
            ts: o["ts"].as_i64().unwrap(),
            status: "pending".into(),
            fiat: "CUP".into(),
            pm_keys: vec!["X".into()],
            ..blank_order(o["id"].as_str().unwrap())
        })
        .collect();
    let filters = Filters {
        fiat: "CUP".into(),
        nodes: ["n1", "n2", "n3"].map(String::from).into(),
        pm_sel: HashSet::from(["X".to_string()]),
    };
    let book = get_book(&orders, &filters, 100.0, |n| market[n].clone(), Some);
    let row = |o: &tasak::logic::orders::BookOrder| json!([o.key, o.price, o.market.as_ref().map(|m| &m.from)]);
    let got = json!({ "asks": book.asks.iter().map(row).collect::<Vec<_>>(), "bids": book.bids.iter().map(row).collect::<Vec<_>>() });
    check(got, &c["expected"], c["note"].as_str().unwrap());
}

// ---------- payment-methods.test.js ----------

#[test]
fn pm_key_cases_of_expected_json() {
    for c in DATA.expected["cases"]["pmKey"].as_array().unwrap() {
        let (text, fiat) = (c["text"].as_str().unwrap(), c["fiat"].as_str().unwrap());
        assert_eq!(
            pm_key(text, &pm_list_for(&DATA.lists, fiat)),
            c["method"].as_str().unwrap(),
            "{text} ({fiat})"
        );
    }
    assert_eq!(
        pm_key("360 CUP de saldo móvil 📲", &pm_list_for(&DATA.lists, "CUP")),
        "Saldo móvil"
    );
    assert_eq!(norm_pm("  Saldo  MÓVIL 📲 🇨🇺 "), "saldo movil");
}

#[test]
fn payment_methods_of_every_order() {
    let by_key: HashMap<String, Order> = load_orders().into_iter().map(|o| (o.key.clone(), o)).collect();
    for e in DATA.expected["orders"].as_array().unwrap() {
        let key = e["key"].as_str().unwrap();
        check(json!(by_key[key].pm_keys), &e["pmKeys"], key);
    }
}

#[test]
fn methods_selected_by_default_per_currency() {
    let orders = load_orders();
    let hidden = hidden_set(&DATA.hidden);
    for (fiat, c) in DATA.expected["currencies"].as_object().unwrap() {
        let keys: Vec<String> = pm_stats(&orders, fiat, &DATA.nodes, DATA.now)
            .into_iter()
            .map(|s| s.key)
            .collect();
        let mut selected: Vec<String> = default_pm_selection(&keys, &hidden).into_iter().collect();
        selected.sort_by(|a, b| tasak::logic::js::cmp(a, b));
        check(json!(selected), &c["activePaymentMethods"], fiat);
    }
}

#[test]
fn test_orders_only_pass_with_pruebas_selected() {
    let o = Order {
        pm_keys: vec!["Pruebas".into(), "Efectivo".into()],
        ..blank_order("x")
    };
    assert!(!order_matches_pm(&o, &HashSet::from(["Efectivo".to_string()])));
    assert!(order_matches_pm(&o, &HashSet::from(["Pruebas".to_string()])));
}

// ---------- rates.test.js ----------

#[test]
fn mostro_rates_parsing_and_currency_per_usd() {
    for c in DATA.cases["mostroRates"]["parse"].as_array().unwrap() {
        let note = c["note"].as_str().unwrap();
        let ev: RawEvent = serde_json::from_value(c["event"].clone()).unwrap();
        let r = parse_rates(&ev);
        check(json!(r), &c["expected"], note);
        for (fiat, v) in c["fiatPerUsd"].as_object().into_iter().flatten() {
            check(json!(fiat_per_usd(r.as_ref(), fiat)), v, &format!("{note}: {fiat}"));
        }
    }
}

#[test]
fn rates_to_use_at_each_moment() {
    for c in DATA.cases["mostroRates"]["current"].as_array().unwrap() {
        let rates: Vec<Rates> = serde_json::from_value(c["rates"].clone()).unwrap();
        for at in c["now"].as_array().unwrap() {
            let got = current_rates(&rates, at[0].as_f64().unwrap()).map(|r| r.id.as_str());
            assert_eq!(got, at[1].as_str(), "{}: {}", c["note"], at[0]);
        }
    }
}

#[test]
fn market_price_of_a_node() {
    for c in DATA.cases["mostroRates"]["market"].as_array().unwrap() {
        let own: Option<Rates> = c["own"].as_object().map(|o| {
            let mut o = o.clone();
            o.insert("id".into(), json!("own"));
            serde_json::from_value(Value::Object(o)).unwrap()
        });
        let got = market_price(
            own.as_ref(),
            c["fiat"].as_str().unwrap(),
            c["now"].as_f64().unwrap(),
            c["fallback"].as_f64(),
        );
        check(json!(got), &c["expected"], c["note"].as_str().unwrap());
    }
}

// ---------- rate.test.js ----------

fn case_trades(v: &Value) -> Vec<Trade> {
    serde_json::from_value(v.clone()).unwrap()
}

#[test]
fn the_faq_example() {
    let t = |price: f64, size: f64| Trade {
        price,
        size,
        ..case_trades(&json!([{ "id": "x", "ts": 0, "price": 0, "size": 0 }]))[0].clone()
    };
    let w = weighted_price(&[t(785.0, 1000.0), t(785.0, 1000.0), t(785.0, 1000.0), t(750.0, 5000.0)]).unwrap();
    assert_eq!(w, DATA.expected["cases"]["faqExample"].as_f64().unwrap());
    assert_eq!(tasak::logic::js::to_fixed(w, 2), "763.13");
}

#[test]
fn tasa_k_24h_border_and_empty_window() {
    for c in DATA.cases["tasaK"].as_array().unwrap() {
        check(
            json!(tasa_k(&case_trades(&c["trades"]), c["now"].as_f64().unwrap())),
            &c["expected"],
            c["note"].as_str().unwrap(),
        );
    }
}

#[test]
fn rate_breakdown_buy_and_sell_market_and_fixed() {
    for c in DATA.cases["rateBreakdown"].as_array().unwrap() {
        check(
            json!(rate_breakdown(&case_trades(&c["trades"]), c["now"].as_f64().unwrap())),
            &c["expected"],
            c["note"].as_str().unwrap(),
        );
    }
}

#[test]
fn rate_breakdown_adds_up_to_the_tasa_k_window() {
    for (name, _, v) in views() {
        let (k, b) = (tasa_k(&v.trades, DATA.now), rate_breakdown(&v.trades, DATA.now));
        assert_eq!(b.buy.count + b.sell.count, k.count, "{name}");
        assert_eq!(b.market + b.fixed + b.unknown, k.count, "{name}");
        assert_eq!(b.buy.volume + b.sell.volume, k.volume, "{name}");
    }
}

#[test]
fn trades_tasa_k_and_previous_24h_per_currency_and_unit() {
    let tz = &DATA.tz;
    for (name, u, v) in views() {
        assert_eq!(
            v.approx,
            u["approximateUsd"].as_bool().unwrap(),
            "{name} approximate USD"
        );
        let trades: Vec<Value> = v
            .trades
            .iter()
            .map(|t| json!({ "key": t.key, "ts": t.ts, "size": t.size, "price": t.price, "chartTime": to_chart_time(t.ts as f64, tz) }))
            .collect();
        check(Value::Array(trades), &u["trades"], &format!("{name} trades"));
        let k = tasa_k(&v.trades, DATA.now);
        check(
            json!([k.rate, k.previous, k.count, k.volume]),
            &json!([u["rate"], u["previousRate"], u["orders24h"], u["volume24h"]]),
            &name,
        );
        assert_eq!(k.ids.len(), k.count);
    }
}

#[test]
fn candles_and_empty_periods_of_every_timeframe() {
    for (name, u, v) in views() {
        for tf in TIMEFRAMES {
            let mut candles = build_candles(&v.trades, tf, &DATA.tz);
            candles.sort_by(|a, b| a.time.total_cmp(&b.time));
            let starts: Vec<f64> = candles.iter().map(|c| c.time).collect();
            let got = json!({ "candles": candles, "emptyPeriods": empty_periods(&starts, tf) });
            check(got, &u["candles"][tf_name(tf)], &format!("{name} {tf}"));
        }
    }
}

#[test]
fn chart_points_with_the_moving_24h_weighted_average() {
    for (name, u, v) in views() {
        for tf in std::iter::once(0.0).chain(TIMEFRAMES) {
            let points: Vec<Value> = chart_points(&v.trades, tf, &DATA.tz, DATA.now, true)
                .into_iter()
                .map(|p| {
                    json!({ "time": p.time, "value": p.value, "vol": p.vol, "n": p.n, "avg": p.avg, "avgN": p.avg_n,
                        "avgVol": p.avg_vol, "empty": p.empty, "key": p.key })
                })
                .collect();
            check(Value::Array(points), &u["points"][tf_name(tf)], &format!("{name} {tf}"));
        }
    }
}

#[test]
fn moving_weighted_average_24h_border() {
    for c in DATA.cases["movingWeighted"].as_array().unwrap() {
        let tz: Tz = c["tz"].as_str().unwrap().parse().unwrap();
        let ends: Vec<f64> = serde_json::from_value(c["ends"].clone()).unwrap();
        check(
            json!(moving_weighted(&ends, &case_trades(&c["trades"]), &tz)),
            &c["expected"],
            c["note"].as_str().unwrap(),
        );
    }
}

// ---------- time.test.js ----------

#[test]
fn period_start_and_next_period() {
    for c in DATA.expected["cases"]["periods"].as_array().unwrap() {
        let (time, tf) = (c["time"].as_f64().unwrap(), c["tf"].as_f64().unwrap());
        let start = period_start(time, tf);
        assert_eq!(start, c["start"].as_f64().unwrap(), "period_start({time}, {tf})");
        assert_eq!(
            next_period(start, tf),
            c["next"].as_f64().unwrap(),
            "next_period({start}, {tf})"
        );
    }
}

#[test]
fn tz_offset_across_dst_changes_in_several_zones() {
    for c in DATA.cases["tzOffset"].as_array().unwrap() {
        let tz: Tz = c["tz"].as_str().unwrap().parse().unwrap();
        let ts = c["ts"].as_f64().unwrap();
        assert_eq!(tz_offset(ts, &tz), c["offset"].as_f64().unwrap(), "{} {ts}", c["tz"]);
    }
}

#[test]
fn tz_offset_same_as_the_old_site_away_from_dst_changes() {
    let near = |ts: f64| {
        [1772946000.0, 1793509200.0]
            .iter()
            .any(|c| (ts - c).abs() < 6.0 * 3600.0)
    };
    for c in DATA.expected["cases"]["buggyOffsets"].as_array().unwrap() {
        let ts = c["ts"].as_f64().unwrap();
        if !near(ts) {
            assert_eq!(tz_offset(ts, &DATA.tz), c["offset"].as_f64().unwrap(), "{ts}");
        }
    }
}

#[test]
fn empty_periods_cases() {
    for c in DATA.cases["emptyPeriods"].as_array().unwrap() {
        let starts: Vec<f64> = serde_json::from_value(c["starts"].clone()).unwrap();
        check(
            json!(empty_periods(&starts, c["tf"].as_f64().unwrap())),
            &c["empty"],
            c["note"].as_str().unwrap(),
        );
    }
}
