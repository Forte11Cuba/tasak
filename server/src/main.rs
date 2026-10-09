//! tasak: reads .env, generates web/config.js, serves web/ and archives the nodes' events in SQLite.
//! Later it will also compute and publish the Tasa K (see the README).

mod archive;
mod config;
mod import;
mod orders;
mod prices;
mod serve;
mod site;
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
Usage: tasak [build | import-jsonl FILE...] [--root DIR]

  tasak                     generates web/config.js from .env, copies shared/ into web/shared/, serves
                            web/ and archives the nodes' events in ARCHIVE_DIR/tasak.sqlite
  tasak build               only generates web/config.js and web/shared/ (to publish web/ with any
                            static server)
  tasak import-jsonl FILE…  imports the daily .jsonl files of the old JavaScript archiver
  --root DIR                the repository folder, with .env, web/ and shared/ (default: the current one)

It listens on LISTEN from .env (default 127.0.0.1:8765); ARCHIVE=false serves without archiving.
Environment variables take precedence over .env.";

const DEFAULT_LISTEN: &str = "127.0.0.1:8765";
/// Relative to the repository folder
const DEFAULT_ARCHIVE_DIR: &str = "data";

enum Command {
    Serve,
    Build,
    Import(Vec<PathBuf>),
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
            (file, Command::Import(files)) if !file.starts_with('-') => files.push(PathBuf::from(file)),
            (other, _) => return usage_error(&format!("unknown argument: {other}")),
        }
    }
    if matches!(&command, Command::Import(files) if files.is_empty()) {
        return usage_error("import-jsonl needs at least one file");
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

    let (config, mut errors) = config::build_config(get, &root.join("web"));
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

    if !matches!(command, Command::Import(_)) {
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
            Command::Serve => {
                let addr = addr.expect("checked above");
                let mut tasks = Vec::new();
                if archive {
                    match open_store().await {
                        Ok((store, path)) => {
                            info!("archiving in {}", path.display());
                            let lists = fs::read_to_string(root.join("web/vendor/mostro-payment-methods.js"))
                                .ok()
                                .and_then(|s| tasak::logic::payment_methods::parse_vendor_script(&s));
                            let Some(lists) = lists else {
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
                            tasks.push(tokio::spawn(orders::run(store.pool().clone(), lists, coinbase)));
                            tasks.push(tokio::spawn(archive::run(store, nodes, config.relays.clone())));
                        }
                        Err(e) => {
                            error!("{e} (ARCHIVE=false serves without archiving)");
                            return ExitCode::FAILURE;
                        }
                    }
                } else {
                    info!("ARCHIVE=false: not archiving");
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
            Command::Build => unreachable!("returned above"),
        }
    })
}

fn usage_error(msg: &str) -> ExitCode {
    eprintln!("{msg}\n\n{USAGE}");
    ExitCode::from(2)
}
