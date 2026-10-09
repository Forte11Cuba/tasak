//! The key that signs the Tasa K: a file of its own (SIGNING_KEY_FILE), outside the repository, readable
//! only by its owner. A key dedicated to the rate: not the Mostro node's, not a personal one.

use nostr_sdk::prelude::*;
use std::fs;
use std::io::Write;
use std::path::Path;

/// `tasak keygen PATH`: a new key, written with permissions 0600 (never over an existing file).
/// Returns its npub, to publish in the READMEs and the FAQ
pub fn keygen(path: &Path) -> Result<String, String> {
    let keys = Keys::generate();
    let nsec = keys.secret_key().to_bech32().map_err(|e| e.to_string())?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options
        .open(path)
        .map_err(|e| format!("cannot create {}: {e}", path.display()))?;
    writeln!(file, "{nsec}").map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    keys.public_key().to_bech32().map_err(|e| e.to_string())
}

/// The key of `path` (nsec or hex). Refused if the file can be read by others, or lies inside a folder
/// that is served or shared (`forbidden`: web/ and the archive's folder)
pub fn load(path: &Path, forbidden: &[&Path]) -> Result<Keys, String> {
    let shown = path.display();
    let real = fs::canonicalize(path).map_err(|e| format!("SIGNING_KEY_FILE {shown}: {e}"))?;
    for dir in forbidden {
        if let Ok(dir) = fs::canonicalize(dir)
            && real.starts_with(&dir)
        {
            return Err(format!(
                "SIGNING_KEY_FILE {shown} is inside {}: move it outside the repository",
                dir.display()
            ));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&real)
            .map_err(|e| format!("SIGNING_KEY_FILE {shown}: {e}"))?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            return Err(format!(
                "SIGNING_KEY_FILE {shown} can be read by other users (permissions {:o}): chmod 600 it",
                mode & 0o777
            ));
        }
    }
    let text = fs::read_to_string(&real).map_err(|e| format!("SIGNING_KEY_FILE {shown}: {e}"))?;
    // The error never includes the file's content
    Keys::parse(text.trim()).map_err(|_| format!("SIGNING_KEY_FILE {shown} doesn't hold a valid key (nsec or hex)"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tasak-test-key-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn keygen_writes_a_private_file_that_loads_back() {
        let dir = temp("gen");
        let path = dir.join("nsec");
        let npub = keygen(&path).unwrap();
        let keys = load(&path, &[]).unwrap();
        assert_eq!(keys.public_key().to_bech32().unwrap(), npub);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Never over an existing key
        assert!(keygen(&path).is_err());
        assert_eq!(load(&path, &[]).unwrap().public_key(), keys.public_key());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_keys_others_can_read_or_inside_served_folders() {
        let dir = temp("refuse");
        let path = dir.join("nsec");
        keygen(&path).unwrap();
        // Inside a forbidden folder (web/, the archive's)
        let err = load(&path, &[&dir]).unwrap_err();
        assert!(err.contains("move it outside"), "{err}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            let err = load(&path, &[]).unwrap_err();
            assert!(err.contains("chmod 600"), "{err}");
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_bad_key_does_not_show_its_content() {
        let dir = temp("bad");
        let path = dir.join("nsec");
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        writeln!(options.open(&path).unwrap(), "not-a-key-but-secret").unwrap();
        let err = load(&path, &[]).unwrap_err();
        assert!(!err.contains("not-a-key"), "{err}");
        let _ = fs::remove_dir_all(dir);
    }
}
