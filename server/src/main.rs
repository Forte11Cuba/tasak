//! tasak: reads .env, generates web/config.js, serves web/ and archives the nodes' events in SQLite.
//! Later it will also compute and publish the Tasa K (see the README).

mod archive;
mod config;
mod import;
mod import_mostro;
mod orders;
mod prices;
mod publish;
mod serve;
mod signing;
mod site;
mod snapshot;
mod store;

use nostr_sdk::prelude::PublicKey;
use std::env;
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use tracing::{error, info, warn};

const USAGE: &str = "\
Usage: tasak [build | import-jsonl FILE... | import-mostro FILE [NODE] | keygen FILE] [--root DIR]

  tasak                     generates web/config.js from .env, copies shared/ into web/shared/, serves
                            web/ and archives the nodes' events in ARCHIVE_DIR/tasak.sqlite
  tasak build               only generates web/config.js and web/shared/ (to publish web/ with any
                            static server)
  tasak import-jsonl FILE…  imports the daily .jsonl files of the old JavaScript archiver
  tasak import-mostro FILE [NODE]
                            imports the completed orders of a COPY of the node's Mostro database
                            (sqlite3 mostro.db \".backup copy.db\"); NODE: its pubkey, if .env has several
  tasak keygen FILE         creates a key to sign the Tasa K (permissions 0600; outside the repository)
                            and shows its npub; set SIGNING_KEY_FILE to it
  --root DIR                the repository folder, with .env, web/ and shared/ (default: the current one)

It listens on LISTEN from .env (default 127.0.0.1:8765); ARCHIVE=false serves without archiving.
Environment variables take precedence over .env.";

const DEFAULT_LISTEN: &str = "127.0.0.1:8765";
/// Relative to the repository folder
const DEFAULT_ARCHIVE_DIR: &str = "data";
/// Decimals of the published rate, as mostro-rates
const DEFAULT_DECIMALS: usize = 2;

enum Command {
    Serve,
    Build,
    Import(Vec<PathBuf>),
    ImportMostro(Option<PathBuf>, Option<String>),
    Keygen(Option<PathBuf>),
}

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .init();

    let mut command = Command::Serve;
    let mut root = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match (arg.as_str(), &mut command) {
            ("--root", _) => match args.next() {
                Some(dir) => root = Some(PathBuf::from(dir)),
                None => return usage_error("--root needs a folder"),
            },
            ("-h" | "--help", _) => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            ("build", Command::Serve) => command = Command::Build,
            ("import-jsonl", Command::Serve) => command = Command::Import(Vec::new()),
            ("import-mostro", Command::Serve) => command = Command::ImportMostro(None, None),
            ("keygen", Command::Serve) => command = Command::Keygen(None),
            (file, Command::Keygen(f @ None)) if !file.starts_with('-') => *f = Some(PathBuf::from(file)),
            (file, Command::ImportMostro(f @ None, _)) if !file.starts_with('-') => *f = Some(PathBuf::from(file)),
            (node, Command::ImportMostro(Some(_), n @ None)) if !node.starts_with('-') => *n = Some(node.to_string()),
            (file, Command::Import(files)) if !file.starts_with('-') => files.push(PathBuf::from(file)),
            (other, _) => return usage_error(&format!("unknown argument: {other}")),
        }
    }
    if matches!(&command, Command::Import(files) if files.is_empty()) {
        return usage_error("import-jsonl needs at least one file");
    }
    if matches!(&command, Command::ImportMostro(None, _)) {
        return usage_error("import-mostro needs the copy of the Mostro database");
    }
    // A new signing key needs nothing else: not the .env, not the repository
    if let Command::Keygen(path) = &command {
        let Some(path) = path else {
            return usage_error("keygen needs the file to create");
        };
        return match signing::keygen(path) {
            Ok(npub) => {
                println!(
                    "Key written to {} (permissions 0600). Its public key:\n{npub}",
                    path.display()
                );
                println!(
                    "Set SIGNING_KEY_FILE={} in .env, keep a backup and never share the file.",
                    path.display()
                );
                ExitCode::SUCCESS
            }
            Err(e) => {
                error!("{e}");
                ExitCode::FAILURE
            }
        };
    }

    let root = match root.map_or_else(env::current_dir, Ok).and_then(fs::canonicalize) {
        Ok(root) if root.join("web/index.html").is_file() && root.join("shared").is_dir() => root,
        Ok(root) => {
            error!(
                "no web/index.html or shared/ in {}: run tasak from the repository folder or pass --root",
                root.display()
            );
            return ExitCode::FAILURE;
        }
        Err(e) => {
            error!("cannot open the folder: {e}");
            return ExitCode::FAILURE;
        }
    };

    let env_file = root.join(".env");
    let file_env = match fs::read_to_string(&env_file) {
        Ok(text) => config::parse_env(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            warn!("no .env file; using environment variables only (see .env.example)");
            Default::default()
        }
        Err(e) => {
            error!("cannot read {}: {e}", env_file.display());
            return ExitCode::FAILURE;
        }
    };
    // Process environment variables take precedence (useful in CI and in systemd units)
    let get = |k: &str| {
        env::var_os(k)
            .map(|v| v.to_string_lossy().into_owned())
            .or_else(|| file_env.get(k).cloned())
    };

    let (mut config, mut errors) = config::build_config(get, &root.join("web"));
    let listen = get("LISTEN")
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_LISTEN.to_string());
    let addr = listen.parse::<SocketAddr>();
    if matches!(command, Command::Serve) && addr.is_err() {
        errors.push(format!(
            "invalid LISTEN (address:port, e.g. {DEFAULT_LISTEN}): {listen}"
        ));
    }
    let archive = match get("ARCHIVE").unwrap_or_default().to_ascii_lowercase().as_str() {
        "" | "true" => true,
        "false" => false,
        other => {
            errors.push(format!("invalid ARCHIVE (true or false): {other}"));
            false
        }
    };
    let archive_dir = root.join(
        get("ARCHIVE_DIR")
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_ARCHIVE_DIR.to_string()),
    );
    let decimals = match get("RATE_DECIMALS").filter(|v| !v.is_empty()) {
        None => DEFAULT_DECIMALS,
        Some(v) => match v.parse::<usize>() {
            Ok(d) if d <= 8 => d,
            _ => {
                errors.push(format!("invalid RATE_DECIMALS (0 to 8): {v}"));
                DEFAULT_DECIMALS
            }
        },
    };
    let signing_key_file = get("SIGNING_KEY_FILE").filter(|v| !v.is_empty()).map(|v| root.join(v));
    // config.rs checked their form; the archive needs them decoded (hex or npub, with its checksum)
    let mut nodes: Vec<PublicKey> = Vec::new();
    for k in &config.mostros {
        match PublicKey::parse(k) {
            Ok(pk) => nodes.push(pk),
            Err(_) if errors.iter().any(|e| e.contains(k.as_str())) => {}
            Err(e) => errors.push(format!("invalid pubkey: {k} ({e})")),
        }
    }
    if !errors.is_empty() {
        eprintln!("Configuration error:\n  {}", errors.join("\n  "));
        return ExitCode::FAILURE;
    }

    // The key that signs the Tasa K: never inside web/ (served) nor the archive's folder. Its public key
    // goes into config.js, for the site to check who signed the rate
    let keys = match (&signing_key_file, &command) {
        (Some(file), Command::Serve | Command::Build) => {
            match signing::load(file, &[&root.join("web"), &archive_dir]) {
                Ok(keys) => {
                    config.rate_pubkey = keys.public_key().to_hex();
                    Some(keys)
                }
                Err(e) => {
                    error!("{e}");
                    return ExitCode::FAILURE;
                }
            }
        }
        _ => None,
    };

    if !matches!(command, Command::Import(_) | Command::ImportMostro(..)) {
        match site::write(&root, &config) {
            Ok(modules) => info!(
                "web/config.js generated: {} node(s), {} relay(s), currency {}; {modules} modules copied to web/shared/",
                config.mostros.len(),
                config.relays.len(),
                if config.fiat.is_empty() { "auto" } else { &config.fiat },
            ),
            Err(e) => {
                error!("cannot write into web/: {e}");
                return ExitCode::FAILURE;
            }
        }
    }
    if matches!(command, Command::Build) {
        return ExitCode::SUCCESS;
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
        let open_store = || async {
            fs::create_dir_all(&archive_dir).map_err(|e| format!("cannot create {}: {e}", archive_dir.display()))?;
            let path = archive_dir.join(store::FILE);
            let pool = store::open(&path).await.map_err(|e| format!("cannot open {}: {e}", path.display()))?;
            let store = store::Store::new(pool, nodes.iter().copied())
                .await
                .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            Ok::<_, String>((Arc::new(store), path))
        };

        match command {
            Command::Import(files) => {
                let (store, path) = match open_store().await {
                    Ok(s) => s,
                    Err(e) => {
                        error!("{e}");
                        return ExitCode::FAILURE;
                    }
                };
                let mut failed = false;
                for file in files {
                    match import::import_file(&store, &file).await {
                        Ok(c) => info!(
                            "{}: {} new events, {} already stored, {} unchanged metadata, {} rejected, {} Yadio responses, {} invalid lines",
                            file.display(), c.new, c.known, c.unchanged, c.rejected, c.yadio, c.invalid_lines
                        ),
                        Err(e) => {
                            error!("{e}");
                            failed = true;
                        }
                    }
                }
                info!("archive: {}", path.display());
                if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS }
            }
            Command::ImportMostro(file, node) => {
                let file = file.expect("checked above");
                // The database doesn't say whose it is: NODE, or the only node of .env
                let node = match (node, nodes.as_slice()) {
                    (Some(k), _) => match PublicKey::parse(&k) {
                        Ok(pk) if nodes.contains(&pk) => pk,
                        Ok(_) => {
                            error!("{k} is not one of the nodes of MOSTRO_PUBKEYS");
                            return ExitCode::FAILURE;
                        }
                        Err(e) => {
                            error!("invalid node {k}: {e}");
                            return ExitCode::FAILURE;
                        }
                    },
                    (None, [only]) => *only,
                    (None, _) => {
                        error!("MOSTRO_PUBKEYS has several nodes: say whose database it is (tasak import-mostro FILE NODE)");
                        return ExitCode::FAILURE;
                    }
                };
                let (store, path) = match open_store().await {
                    Ok(s) => s,
                    Err(e) => {
                        error!("{e}");
                        return ExitCode::FAILURE;
                    }
                };
                let imported = match import_mostro::import(store.pool(), &file, &node.to_hex(), archive::now()).await {
                    Ok(i) => i,
                    Err(e) => {
                        error!("{e}");
                        return ExitCode::FAILURE;
                    }
                };
                info!("{}: {} completed orders imported into {}", file.display(), imported.success, path.display());
                for (status, n) in &imported.other {
                    info!("  {n} {status} not imported: only success counts");
                }
                if !imported.missing.is_empty() {
                    info!("  columns this database lacks (read as empty): {}", imported.missing.join(", "));
                }
                // Into `orders` and priced, as the server would do in its next minute
                let Some(lists) = read_lists(&root) else {
                    error!("cannot read web/vendor/mostro-payment-methods.js");
                    return ExitCode::FAILURE;
                };
                match orders::sync(store.pool(), &lists, orders::Cursor::default()).await {
                    Ok((synced, _)) => info!("orders: {} completed orders", synced.completed),
                    Err(e) => {
                        error!("orders: {e}");
                        return ExitCode::FAILURE;
                    }
                }
                let priced = match prices::Coinbase::new() {
                    Ok(c) => prices::price_orders(store.pool(), &c, &mut prices::Asked::new()).await,
                    Err(e) => {
                        error!("coinbase: {e}");
                        return ExitCode::FAILURE;
                    }
                };
                match priced {
                    Ok(n) => info!("orders: {n} priced in USD"),
                    Err(e) => error!("orders: cannot price: {e}"),
                }
                ExitCode::SUCCESS
            }
            Command::Serve => {
                let addr = addr.expect("checked above");
                let mut tasks = Vec::new();
                if archive {
                    match open_store().await {
                        Ok((store, path)) => {
                            info!("archiving in {}", path.display());
                            let Some(lists) = read_lists(&root) else {
                                error!("cannot read web/vendor/mostro-payment-methods.js");
                                return ExitCode::FAILURE;
                            };
                            let coinbase = match prices::Coinbase::new() {
                                Ok(c) => c,
                                Err(e) => {
                                    error!("coinbase: {e}");
                                    return ExitCode::FAILURE;
                                }
                            };
                            match &keys {
                                None => info!("no SIGNING_KEY_FILE: the Tasa K is computed (web/api/) but not published on Nostr"),
                                Some(k) => info!(
                                    "signing the Tasa K as {}",
                                    nostr_sdk::prelude::ToBech32::to_bech32(&k.public_key()).unwrap_or_default()
                                ),
                            }
                            let rules = publish::Rules {
                                nodes: nodes.iter().map(|n| n.to_hex()).collect(),
                                fiat: config.fiat.clone(),
                                hidden: config.hidden_payment_methods.clone(),
                                decimals,
                            };
                            tasks.push(tokio::spawn(orders::run(store.pool().clone(), lists, coinbase)));
                            tasks.push(tokio::spawn(publish::run(
                                store.pool().clone(),
                                rules,
                                config.relays.clone(),
                                keys.clone(),
                                root.join("web/api"),
                            )));
                            tasks.push(tokio::spawn(archive::run(store, nodes, config.relays.clone())));
                        }
                        Err(e) => {
                            error!("{e} (ARCHIVE=false serves without archiving)");
                            return ExitCode::FAILURE;
                        }
                    }
                } else {
                    info!("ARCHIVE=false: not archiving");
                    if signing_key_file.is_some() {
                        warn!("SIGNING_KEY_FILE is set but ARCHIVE=false: the Tasa K is computed from the archive, so it isn't published");
                    }
                }
                let served = serve::serve(root.join("web"), addr).await;
                for task in tasks {
                    task.abort();
                }
                match served {
                    Ok(()) => ExitCode::SUCCESS,
                    Err(e) => {
                        error!("cannot serve on {addr}: {e}");
                        ExitCode::FAILURE
                    }
                }
            }
            Command::Build | Command::Keygen(_) => unreachable!("returned above"),
        }
    })
}

/// The payment methods of the Mostro app per currency (web/vendor/)
fn read_lists(root: &std::path::Path) -> Option<tasak::logic::payment_methods::PmLists> {
    let script = fs::read_to_string(root.join("web/vendor/mostro-payment-methods.js")).ok()?;
    tasak::logic::payment_methods::parse_vendor_script(&script)
}

fn usage_error(msg: &str) -> ExitCode {
    eprintln!("{msg}\n\n{USAGE}");
    ExitCode::from(2)
}
