//! Serves web/ as static files: only GET and HEAD, only files inside web/, nothing that receives data.
//! HTTPS is up to the operator (nginx, Caddy…) in front of it.

use axum::Router;
use axum::http::HeaderValue;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS};
use axum::middleware::map_response;
use axum::response::Response;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use tokio::net::TcpListener;
use tower_http::services::ServeDir;
use tracing::info;

pub async fn serve(web: PathBuf, addr: SocketAddr) -> io::Result<()> {
    let app = Router::new()
        .fallback_service(ServeDir::new(&web))
        .layer(map_response(headers));
    let listener = TcpListener::bind(addr).await?;
    info!("serving {} at http://{addr}/", web.display());
    axum::serve(listener, app).with_graceful_shutdown(shutdown()).await
}

async fn headers(mut res: Response) -> Response {
    let h = res.headers_mut();
    // Text files are UTF-8 (the classic scripts would otherwise depend on the page's encoding)
    if let Some(ct) = h.get(CONTENT_TYPE).and_then(|v| v.to_str().ok())
        && ct.starts_with("text/")
        && !ct.contains("charset")
        && let Ok(v) = HeaderValue::from_str(&format!("{ct}; charset=utf-8"))
    {
        h.insert(CONTENT_TYPE, v);
    }
    // Always revalidated (cheap: 304 with Last-Modified), so a new config.js or release shows at once
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    h.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    res
}

/// Ctrl+C, or SIGTERM from systemd
async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
    info!("stopping");
}
