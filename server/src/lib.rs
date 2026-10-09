//! The logic of tasaK that the server shares with the site: the Rust version of shared/ (JavaScript,
//! used by the pages). Both pass the same vectors (shared/test/expected.json and cases.json), so the
//! rate the server signs is the one any visitor can recompute in the browser.

pub mod logic;
