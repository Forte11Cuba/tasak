//! Writes what build.mjs writes into web/: config.js and a copy of shared/*.js (without its tests)

use crate::config::{Config, render_config};
use std::fs;
use std::io;
use std::path::Path;

/// Returns how many modules were copied to web/shared/
pub fn write(root: &Path, config: &Config) -> io::Result<usize> {
    let web = root.join("web");
    fs::write(web.join("config.js"), render_config(config))?;

    let dst = web.join("shared");
    match fs::remove_dir_all(&dst) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    fs::create_dir(&dst)?;
    let mut copied = 0;
    for entry in fs::read_dir(root.join("shared"))? {
        let name = entry?.file_name();
        if name.to_string_lossy().ends_with(".js") {
            fs::copy(root.join("shared").join(&name), dst.join(&name))?;
            copied += 1;
        }
    }
    Ok(copied)
}
