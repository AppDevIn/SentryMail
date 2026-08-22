//! The three public feeds, and the parsing of each.
//!
//! Parsing is deliberately split from fetching so it can be unit-tested against fixtures with
//! no network involved.

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    PhishTank,
    OpenPhish,
    UrlHaus,
}

impl Source {
    pub fn as_str(&self) -> &'static str {
        match self {
            Source::PhishTank => "phishtank",
            Source::OpenPhish => "openphish",
            Source::UrlHaus => "urlhaus",
        }
    }

    pub fn url(&self) -> &'static str {
        match self {
            // JSON rather than CSV: PhishTank's CSV quotes commas inside the `target` field,
            // and serde_json is already a dependency while a CSV parser is not.
            Source::PhishTank => "http://data.phishtank.com/data/online-valid.json.gz",
            Source::OpenPhish => "https://openphish.com/feed.txt",
            Source::UrlHaus => "https://urlhaus.abuse.ch/downloads/text/",
        }
    }

    /// Whether the body arrives gzip-compressed by file extension (not transfer-encoding, which
    /// reqwest would handle itself).
    pub fn is_gzipped(&self) -> bool {
        matches!(self, Source::PhishTank)
    }

    pub const ALL: [Source; 3] = [Source::PhishTank, Source::OpenPhish, Source::UrlHaus];
}

/// Only the fields we use. PhishTank sends far more per entry.
#[derive(Debug, Deserialize)]
struct PhishTankEntry {
    url: String,
    /// "yes" / "no" - unverified submissions are not trustworthy enough to block on.
    #[serde(default)]
    verified: String,
    /// "yes" / "no" - a dead phishing page is not worth warning about.
    #[serde(default)]
    online: String,
}

/// Extracts URLs from a feed body. Unparseable lines are skipped rather than failing the whole
/// refresh: one malformed entry must not cost the user their entire blocklist.
pub fn parse(source: Source, body: &str) -> Vec<String> {
    match source {
        Source::PhishTank => parse_phishtank(body),
        Source::OpenPhish | Source::UrlHaus => parse_url_list(body),
    }
}

fn parse_phishtank(body: &str) -> Vec<String> {
    let entries: Vec<PhishTankEntry> = match serde_json::from_str(body) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    entries
        .into_iter()
        // The feed is named "online-valid" but carries the flags anyway; honour them, since
        // blocking on an unverified or dead entry is a false positive we can cheaply avoid.
        .filter(|e| !e.verified.eq_ignore_ascii_case("no") && !e.online.eq_ignore_ascii_case("no"))
        .map(|e| e.url)
        .collect()
}

/// One URL per line, `#` comments, blank lines ignored. Covers OpenPhish and URLhaus.
fn parse_url_list(body: &str) -> Vec<String> {
    body.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_phishtank_json_and_honours_flags() {
        let body = r#"[
          {"phish_id":1,"url":"http://evil.example.com/login","verified":"yes","online":"yes"},
          {"phish_id":2,"url":"http://dead.example.com/x","verified":"yes","online":"no"},
          {"phish_id":3,"url":"http://unverified.example.com/x","verified":"no","online":"yes"}
        ]"#;
        let urls = parse(Source::PhishTank, body);
        assert_eq!(urls, vec!["http://evil.example.com/login"]);
    }

    #[test]
    fn malformed_phishtank_json_yields_nothing_rather_than_panicking() {
        assert!(parse(Source::PhishTank, "{not json").is_empty());
    }

    #[test]
    fn parses_plain_url_lists_with_comments() {
        let body = "# OpenPhish feed\n\nhttps://a.example/x\n  https://b.example/y  \n\n# end\n";
        assert_eq!(
            parse(Source::OpenPhish, body),
            vec!["https://a.example/x", "https://b.example/y"]
        );
        assert_eq!(parse(Source::UrlHaus, body).len(), 2);
    }

    #[test]
    fn only_phishtank_is_gzipped() {
        assert!(Source::PhishTank.is_gzipped());
        assert!(!Source::OpenPhish.is_gzipped());
        assert!(!Source::UrlHaus.is_gzipped());
    }
}
