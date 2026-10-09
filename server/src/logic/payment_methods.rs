//! Payment methods (shared/payment-methods.js). Makers type the method by hand; it is matched against
//! the Mostro app's list for that currency (web/vendor/mostro-payment-methods.js), and whatever does
//! not match (phone numbers, notes, unusual banks…) goes to «Otros».

use super::js;
use super::orders::Order;
use regex::Regex;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

pub const OTHERS: &str = "Otros";
pub const TESTS: &str = "Pruebas";
pub const NO_METHOD: &str = "Sin método";
const FALLBACK_LIST: [&str; 2] = ["Bank Transfer", "Cash in person"];

/// The app's methods per currency, with `default` for the currencies it doesn't list
pub type PmLists = HashMap<String, Vec<String>>;

static PICTOGRAPHS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{Extended_Pictographic}|\p{Regional_Indicator}").unwrap());
// JavaScript's \b without the u flag: between an ASCII word character and anything else
static IS_TEST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"prueba|(?-u:\b)test(?-u:\b)|no tomar").unwrap());

/// Combining diacritical marks (U+0300–U+036F): the accents NFD separates from their letter
fn is_mark(c: &char) -> bool {
    ('\u{0300}'..='\u{036F}').contains(c)
}

fn without_accents(s: &str) -> String {
    s.nfd().filter(|c| !is_mark(c)).collect()
}

/// Compared without accents, case, emojis or flags, and with collapsed spaces
pub fn norm_pm(s: &str) -> String {
    let lower = PICTOGRAPHS.replace_all(&without_accents(s), "").to_lowercase();
    lower
        .split(js::is_js_space)
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The lists of web/vendor/mostro-payment-methods.js, a classic script that sets
/// `window.MOSTRO_PAYMENT_METHODS = {…};`: its object is JSON
pub fn parse_vendor_script(script: &str) -> Option<PmLists> {
    let object = &script[script.find('{')?..=script.rfind('}')?];
    serde_json::from_str(object).ok()
}

/// Methods of a currency: its list, `default`, or the fallback
pub fn pm_list_for(lists: &PmLists, fiat: &str) -> Vec<String> {
    lists
        .get(fiat)
        .or_else(|| lists.get("default"))
        .cloned()
        .unwrap_or_else(|| FALLBACK_LIST.map(String::from).to_vec())
}

/// Method of the list that a free text refers to
pub fn pm_key(raw: &str, list: &[String]) -> String {
    let s = norm_pm(raw);
    if IS_TEST.is_match(&s) {
        return TESTS.to_string();
    }
    let norm: Vec<(&String, String)> = list.iter().map(|m| (m, norm_pm(m))).collect();
    // 1) equal («Cash» → Cash, not Cash App); 2) the text contains the method, the longest one
    // («360 CUP de saldo móvil 📲» → Saldo móvil); 3) the text is part of a single method («Clásica»)
    if let Some((m, _)) = norm.iter().find(|(_, n)| *n == s) {
        return m.to_string();
    }
    // The first of the longest (a stable sort by length, descending)
    let mut inside: Option<&(&String, String)> = None;
    for x in norm.iter().filter(|(_, n)| s.contains(n.as_str())) {
        if inside.is_none_or(|best| js::len(&x.1) > js::len(&best.1)) {
            inside = Some(x);
        }
    }
    if let Some((m, _)) = inside {
        return m.to_string();
    }
    let partial: Vec<_> = if js::len(&s) >= 4 {
        norm.iter().filter(|(_, n)| n.contains(&s)).collect()
    } else {
        vec![]
    };
    if partial.len() == 1 {
        partial[0].0.to_string()
    } else {
        OTHERS.to_string()
    }
}

/// Whether an order passes the selected methods; test orders only with «Pruebas» selected
pub fn order_matches_pm(o: &Order, selected: &HashSet<String>) -> bool {
    if o.pm_keys.iter().any(|k| k == TESTS) {
        return selected.contains(TESTS);
    }
    o.pm_keys.iter().any(|k| selected.contains(k))
}

/// Hidden by default: HIDDEN_PAYMENT_METHODS of the .env
pub fn hidden_set(names: &[String]) -> HashSet<String> {
    names.iter().map(|n| norm_pm(n)).collect()
}

pub fn is_hidden(key: &str, hidden: &HashSet<String>) -> bool {
    hidden.contains(&norm_pm(key))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PmStat {
    pub key: String,
    /// Completed orders
    pub done: usize,
    /// Open orders: pending and not expired
    pub open: usize,
}

/// Methods of a currency with completed and open orders of each, in the filter's order: «Otros»
/// last, then most completed, most open and by name
pub fn pm_stats(orders: &[Order], fiat: &str, nodes: &HashSet<String>, now: f64) -> Vec<PmStat> {
    let mut stats: Vec<PmStat> = Vec::new();
    for o in orders {
        if o.fiat != fiat || !nodes.contains(&o.node) {
            continue;
        }
        let open = o.status == "pending" && !(js::truthy(o.expires_at) && o.expires_at < now);
        for k in &o.pm_keys {
            let i = match stats.iter().position(|s| &s.key == k) {
                Some(i) => i,
                None => {
                    stats.push(PmStat {
                        key: k.clone(),
                        done: 0,
                        open: 0,
                    });
                    stats.len() - 1
                }
            };
            if o.status == "success" {
                stats[i].done += 1;
            }
            if open {
                stats[i].open += 1;
            }
        }
    }
    stats.sort_by(|a, b| {
        (a.key == OTHERS)
            .cmp(&(b.key == OTHERS))
            .then(b.done.cmp(&a.done))
            .then(b.open.cmp(&a.open))
            .then_with(|| locale_compare(&a.key, &b.key))
    });
    stats
}

/// Selected by default: every method that is not hidden
pub fn default_pm_selection(keys: &[String], hidden: &HashSet<String>) -> HashSet<String> {
    keys.iter().filter(|k| !is_hidden(k, hidden)).cloned().collect()
}

/// Close to `localeCompare` (Unicode collation, which Rust doesn't have): letters first without
/// accents or case, then accents, then lowercase before uppercase. Only orders the filter's list
fn locale_compare(a: &str, b: &str) -> Ordering {
    let base = |s: &str| without_accents(s).to_lowercase();
    let accents = |s: &str| -> String { s.to_lowercase().nfd().collect() };
    let case = |s: &str| -> Vec<bool> { s.chars().map(char::is_uppercase).collect() };
    base(a)
        .cmp(&base(b))
        .then_with(|| accents(a).cmp(&accents(b)))
        .then_with(|| case(a).cmp(&case(b)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn cash_is_not_cash_app_and_the_longest_method_contained_wins() {
        assert_eq!(pm_key("Cash", &list(&["Cash", "Cash App"])), "Cash");
        assert_eq!(pm_key("cash app", &list(&["Cash", "Cash App"])), "Cash App");
        assert_eq!(pm_key("pago en efectivo", &list(&["Efectivo", "En"])), "Efectivo");
    }

    #[test]
    fn norm_pm_ignores_accents_case_emojis_flags_and_spaces() {
        assert_eq!(norm_pm("  Saldo  MÓVIL 📲 🇨🇺 "), "saldo movil");
    }

    #[test]
    fn tests_by_word() {
        let l = list(&["Efectivo"]);
        assert_eq!(pm_key("Test", &l), TESTS);
        assert_eq!(pm_key("orden de prueba", &l), TESTS);
        assert_eq!(pm_key("NO TOMAR", &l), TESTS);
        // «test» inside a word is not a test order
        assert_eq!(pm_key("contestar", &l), OTHERS);
    }

    #[test]
    fn locale_order_ignores_case_and_accents_first() {
        let mut v = list(&["Zelle", "efectivo", "Ébano", "EnZona", "Banco"]);
        v.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(v, list(&["Banco", "Ébano", "efectivo", "EnZona", "Zelle"]));
    }
}
