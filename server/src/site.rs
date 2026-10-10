//! Writes into web/ what the site needs besides its own files: config.js, its icon (favicon.svg) and a
//! copy of shared/*.js (without its tests)

use crate::config::{Config, render_config};
use std::fs;
use std::io;
use std::path::Path;

/// Returns how many modules were copied to web/shared/
pub fn write(root: &Path, config: &Config) -> io::Result<usize> {
    let web = root.join("web");
    fs::write(web.join("config.js"), render_config(config))?;
    fs::write(web.join("favicon.svg"), favicon(&config.site_name))?;

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

/// The site's icon: the capitals that end its name (tasaK → K), as the logo highlights them, or its first
/// letter; at most two. A file and not an image data: URI, which the Content Security Policy would block
pub fn favicon(site_name: &str) -> String {
    let caps: String = {
        let tail: Vec<char> = site_name.chars().rev().take_while(|c| c.is_ascii_uppercase()).collect();
        tail.into_iter().rev().collect()
    };
    let letter: String = if !caps.is_empty() {
        caps
    } else {
        site_name.chars().next().map_or_else(|| "K".to_string(), String::from)
    };
    let letter: String = letter.chars().take(2).collect();
    let size = if letter.chars().count() > 1 { 16 } else { 22 };
    let text = letter.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0b0e11"/><text x="16" y="24" font-size="{size}" font-weight="800" text-anchor="middle" fill="#f0b90b" font-family="sans-serif">{text}</text></svg>"##
    )
}

#[cfg(test)]
mod tests {
    use super::favicon;

    #[test]
    fn the_icon_letter_comes_from_the_site_name() {
        let letter = |name: &str| {
            let svg = favicon(name);
            let start = svg.find("sans-serif\">").unwrap() + "sans-serif\">".len();
            svg[start..svg.find("</text>").unwrap()].to_string()
        };
        assert_eq!(letter("tasaK"), "K");
        assert_eq!(letter("Tasa VE"), "VE");
        assert_eq!(letter("BOLIVIA"), "BO");
        assert_eq!(letter("mi sitio"), "m");
        assert_eq!(letter("Ñandú"), "Ñ");
        assert_eq!(letter(""), "K");
        assert_eq!(letter("<b"), "&lt;");
        assert!(favicon("tasaK").contains(r#"font-size="22""#));
        assert!(favicon("Tasa VE").contains(r#"font-size="16""#));
    }
}
