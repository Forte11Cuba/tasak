//! tasak: reads .env, generates web/config.js and serves web/.
//! Later it will also archive the node's events and publish the Tasa K (see the README).

mod config;
mod serve;
mod site;

use std::env;
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use tracing::{error, info, warn};

const USAGE: &str = "\
Usage: tasak [build] [--root DIR]

  tasak          generates web/config.js from .env, copies shared/ into web/shared/ and serves web/
  tasak build    only generates them (to publish web/ with any static server)
  --root DIR     the repository folder, with .env, web/ and shared/ (default: the current folder)

It listens on LISTEN from .env (default 127.0.0.1:8765). Environment variables take precedence over .env.";

const DEFAULT_LISTEN: &str = "127.0.0.1:8765";

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .init();

    let mut serve = true;
    let mut root = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "build" => serve = false,
            "--root" => match args.next() {
                Some(dir) => root = Some(PathBuf::from(dir)),
                None => return usage_error("--root needs a folder"),
            },
            "-h" | "--help" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            other => return usage_error(&format!("unknown argument: {other}")),
        }
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
    if serve && addr.is_err() {
        errors.push(format!(
            "invalid LISTEN (address:port, e.g. {DEFAULT_LISTEN}): {listen}"
        ));
    }
    if !errors.is_empty() {
        eprintln!("Configuration error:\n  {}", errors.join("\n  "));
        return ExitCode::FAILURE;
    }

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
    if !serve {
        return ExitCode::SUCCESS;
    }

    let addr = addr.expect("checked above");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    match runtime.block_on(serve::serve(root.join("web"), addr)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            error!("cannot serve on {addr}: {e}");
            ExitCode::FAILURE
        }
    }
}

fn usage_error(msg: &str) -> ExitCode {
    eprintln!("{msg}\n\n{USAGE}");
    ExitCode::from(2)
}
