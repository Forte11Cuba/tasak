//! Reads .env and builds web/config.js: format, defaults, validations and bytes fixed by the
//! vectors in server/tests/config-cases.json. The .env reader follows JavaScript's rules (it was
//! first written in JS, and the vectors were frozen with it).

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tasak::logic::js::is_js_space;

/// What JavaScript's `.` doesn't match
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// The .env format: KEY=value lines, # comments, optional quotes around the value; later lines win.
pub fn parse_env(text: &str) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if js_trim(line).starts_with('#') {
            continue;
        }
        if let Some((key, value)) = parse_line(line) {
            env.insert(key.to_string(), value.to_string());
        }
    }
    env
}

/// Like /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/ in JavaScript, then /^(["']).*\1$/ removes the quotes
fn parse_line(line: &str) -> Option<(&str, &str)> {
    let rest = line.trim_start_matches(is_js_space);
    let key_len = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(rest.len());
    if key_len == 0 {
        return None;
    }
    let (key, rest) = rest.split_at(key_len);
    let value = js_trim(rest.trim_start_matches(is_js_space).strip_prefix('=')?);
    if value.contains(is_line_terminator) {
        return None;
    }
    let b = value.as_bytes();
    let quoted = b.len() >= 2 && (b[0] == b'"' || b[0] == b'\'') && b[b.len() - 1] == b[0];
    Some((key, if quoted { &value[1..value.len() - 1] } else { value }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub site_name: String,
    pub rate_name: String,
    pub logo: String,
    pub logo_light: String,
    /// The browser tab's icon: a file in web/ (svg, png or ico); empty = the one tasak generates
    pub favicon: String,
    /// Default theme (light | dark); empty = the system's
    pub theme: String,
    /// Default language (es | en); empty = the browser's
    pub language: String,
    pub mostros: Vec<String>,
    pub relays: Vec<String>,
    /// Empty: the most traded currency on the node and the visitor's browser time zone
    pub fiat: String,
    pub time_zone: String,
    pub community: Community,
    pub social_links: Vec<String>,
    pub hidden_payment_methods: Vec<String>,
    /// The key that signs the published Tasa K (hex), from SIGNING_KEY_FILE: the site checks the rate's
    /// author with it. Set by the server after reading the key; empty without one
    pub rate_pubkey: String,
}

#[derive(Debug, Serialize)]
pub struct Community {
    pub name: String,
    pub url: String,
}

fn list(s: Option<String>) -> Vec<String> {
    s.unwrap_or_default()
        .split(|c| c == ',' || is_js_space(c))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// `get` gives a variable's value (the process environment first, then .env); `web` is the web/ folder,
/// to check the logos. The config is only valid if the errors are empty.
pub fn build_config(get: impl Fn(&str) -> Option<String>, web: &Path) -> (Config, Vec<String>) {
    let or_empty = |k: &str| get(k).unwrap_or_default();
    let or_default = |k: &str, d: &str| get(k).filter(|v| !v.is_empty()).unwrap_or_else(|| d.to_string());
    let one_of = |k: &str, allowed: &[&str]| get(k).filter(|v| allowed.contains(&v.as_str())).unwrap_or_default();
    let config = Config {
        site_name: or_default("SITE_NAME", "tasaK"),
        rate_name: or_default("RATE_NAME", "Tasa K"),
        logo: or_empty("LOGO"),
        logo_light: or_empty("LOGO_LIGHT"),
        favicon: or_empty("FAVICON"),
        theme: one_of("THEME", &["light", "dark"]),
        language: one_of("LANGUAGE", &["es", "en"]),
        mostros: list(get("MOSTRO_PUBKEYS")),
        relays: list(get("RELAYS")),
        fiat: or_empty("FIAT").to_uppercase(),
        time_zone: or_empty("TIMEZONE"),
        community: Community {
            name: or_empty("COMMUNITY"),
            url: or_empty("COMMUNITY_URL"),
        },
        social_links: list(get("SOCIAL_LINKS")),
        // Comma separated only: names may contain spaces («Saldo móvil»)
        hidden_payment_methods: match get("HIDDEN_PAYMENT_METHODS") {
            None => vec!["Pruebas".to_string(), "Otros".to_string()],
            Some(s) => s
                .split(',')
                .map(js_trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
        },
        rate_pubkey: String::new(),
    };

    let mut errors = Vec::new();
    if config.mostros.is_empty() {
        errors.push("MOSTRO_PUBKEYS is empty".to_string());
    }
    for k in &config.mostros {
        if !valid_pubkey(k) {
            errors.push(format!("invalid pubkey: {k}"));
        }
    }
    if config.relays.is_empty() {
        errors.push("RELAYS is empty".to_string());
    }
    for r in &config.relays {
        // Encrypted only (wss://); ws:// just for a local test relay
        if !valid_relay(r) {
            errors.push(format!("invalid relay (must start with wss://): {r}"));
        }
    }
    let links = std::iter::once(&config.community.url).chain(&config.social_links);
    for u in links.filter(|u| !u.is_empty()) {
        if !is_https(u) {
            errors.push(format!("invalid link (must start with https://): {u}"));
        }
    }
    // The browser checks it with Intl; both use the IANA database
    if !config.time_zone.is_empty() && chrono_tz::Tz::from_str_insensitive(&config.time_zone).is_err() {
        errors.push(format!("invalid TIMEZONE: {}", config.time_zone));
    }
    for (k, v) in [("LOGO", &config.logo), ("LOGO_LIGHT", &config.logo_light)] {
        if v.is_empty() {
            continue;
        }
        if !is_https(v) && !is_image_path(v) {
            errors.push(format!("invalid {k} (.svg/.png/.jpg/.webp file or https link): {v}"));
        } else if strip_prefix_ci(v, "https://").is_none() {
            check_web_file(web, k, v, &mut errors);
        }
    }
    // Only a file of the site: an icon from another server could fail or be blocked (and the Content
    // Security Policy only allows the site's own images besides https ones)
    let favicon = &config.favicon;
    if !favicon.is_empty() {
        if !is_icon_path(favicon) {
            errors.push(format!("invalid FAVICON (.svg/.png/.ico file in web/): {favicon}"));
        } else if resolve(web, favicon) == web.join("favicon.svg") {
            // tasak writes its own icon there on every build
            errors.push(format!(
                "FAVICON can't be favicon.svg, the icon tasak generates: rename yours ({favicon})"
            ));
        } else {
            check_web_file(web, "FAVICON", favicon, &mut errors);
        }
    }
    (config, errors)
}

pub fn render_config(config: &Config) -> String {
    let json = serde_json::to_string_pretty(config).expect("the config is always serializable");
    format!("// Generated from .env by tasak. Do not edit by hand.\nwindow.TASAK_CONFIG = {json};\n")
}

/// The prefix, ignoring ASCII case (like the /i of a JavaScript regular expression)
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let n = prefix.len();
    (s.len() >= n && s.as_bytes()[..n].eq_ignore_ascii_case(prefix.as_bytes())).then(|| &s[n..])
}

/// \S+
fn no_spaces(s: &str) -> bool {
    !s.is_empty() && !s.contains(is_js_space)
}

/// /^https:\/\/\S+$/i
fn is_https(s: &str) -> bool {
    strip_prefix_ci(s, "https://").is_some_and(no_spaces)
}

/// /^([0-9a-f]{64}|npub1[02-9ac-hj-np-z]{58})$/i
fn valid_pubkey(k: &str) -> bool {
    const BECH32: &[u8] = b"023456789acdefghjklmnpqrstuvwxyz";
    let b = k.as_bytes();
    (b.len() == 64 && b.iter().all(u8::is_ascii_hexdigit))
        || (b.len() == 63
            && b[..5].eq_ignore_ascii_case(b"npub1")
            && b[5..].iter().all(|c| BECH32.contains(&c.to_ascii_lowercase())))
}

/// /^wss:\/\/\S+$/i or /^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/i
fn valid_relay(r: &str) -> bool {
    if strip_prefix_ci(r, "wss://").is_some_and(no_spaces) {
        return true;
    }
    let Some(rest) = strip_prefix_ci(r, "ws://") else {
        return false;
    };
    let Some(rest) = strip_prefix_ci(rest, "localhost").or_else(|| rest.strip_prefix("127.0.0.1")) else {
        return false;
    };
    let rest = match rest.strip_prefix(':') {
        Some(port) => {
            let digits = port.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                return false;
            }
            &port[digits..]
        }
        None => rest,
    };
    rest.is_empty() || rest.strip_prefix('/').is_some_and(|path| !path.contains(is_js_space))
}

/// /^[\w./-]+\.(svg|png|jpe?g|webp)$/i
fn is_image_path(v: &str) -> bool {
    let lower = v.to_ascii_lowercase();
    v.bytes().all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
        && [".svg", ".png", ".jpg", ".jpeg", ".webp"]
            .iter()
            .any(|e| lower.len() > e.len() && lower.ends_with(e))
}

/// /^[\w./-]+\.(svg|png|ico)$/i
fn is_icon_path(v: &str) -> bool {
    let lower = v.to_ascii_lowercase();
    v.bytes().all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
        && [".svg", ".png", ".ico"]
            .iter()
            .any(|e| lower.len() > e.len() && lower.ends_with(e))
}

/// Like JavaScript's `new URL(v, web)`: `.` and `..` resolved by name, not through the file system
/// A file of the site must exist and be inside web/ (also through symlinks): only web/ is served
fn check_web_file(web: &Path, k: &str, v: &str, errors: &mut Vec<String>) {
    let file = resolve(web, v).canonicalize().ok().filter(|f| f.is_file());
    match (file, web.canonicalize()) {
        (Some(file), Ok(root)) if file.starts_with(&root) => {}
        (Some(_), _) => errors.push(format!("{k} must be a file inside web/: {v}")),
        (None, _) => errors.push(format!("{k} file not found in web/: {v}")),
    }
}

fn resolve(web: &Path, v: &str) -> PathBuf {
    let mut path = if v.starts_with('/') {
        PathBuf::from("/")
    } else {
        web.to_path_buf()
    };
    for part in v.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                path.pop();
            }
            name => path.push(name),
        }
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn config_cases() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let text = std::fs::read_to_string(dir.join("server/tests/config-cases.json")).unwrap();
        let vectors: Value = serde_json::from_str(&text).unwrap();
        let web = dir.join("web");
        for case in vectors["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let file_env = case["env"].as_str().map(parse_env).unwrap_or_default();
            let process_env = case["processEnv"].as_object().unwrap();
            let get = |k: &str| {
                process_env
                    .get(k)
                    .map(|v| v.as_str().unwrap().to_string())
                    .or_else(|| file_env.get(k).cloned())
            };
            let (config, errors) = build_config(get, &web);
            let want: Vec<&str> = case["errors"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e.as_str().unwrap())
                .collect();
            assert_eq!(errors, want, "{name}");
            if errors.is_empty() {
                assert_eq!(render_config(&config), case["configJs"].as_str().unwrap(), "{name}");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn site_files_stay_inside_web() {
        let dir = std::env::temp_dir().join(format!("tasak-config-{}", std::process::id()));
        let web = dir.join("web");
        std::fs::create_dir_all(&web).unwrap();
        std::fs::write(dir.join("outside.svg"), "<svg/>").unwrap();
        std::fs::write(web.join("inside.svg"), "<svg/>").unwrap();
        std::os::unix::fs::symlink(dir.join("outside.svg"), web.join("link.svg")).unwrap();
        let errors_for = |v: &str| {
            let mut errors = vec![];
            check_web_file(&web, "FAVICON", v, &mut errors);
            errors
        };
        assert!(errors_for("inside.svg").is_empty());
        assert!(errors_for("./sub/../inside.svg").is_empty());
        let outside = dir.join("outside.svg").to_string_lossy().into_owned();
        for v in ["../outside.svg", outside.as_str(), "link.svg"] {
            assert_eq!(
                errors_for(v),
                [format!("FAVICON must be a file inside web/: {v}")],
                "{v}"
            );
        }
        assert_eq!(errors_for("."), ["FAVICON file not found in web/: ."]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn env_lines() {
        let env = parse_env("\u{FEFF}A = 'x' \r\nB=\"y\nC=a\u{2028}b\n#D=1\nE\u{85}=1");
        let want = HashMap::from([("A".to_string(), "x".to_string()), ("B".to_string(), "\"y".to_string())]);
        assert_eq!(env, want);
    }
}
