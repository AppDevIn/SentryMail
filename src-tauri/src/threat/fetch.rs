//! Downloading the feeds.
//!
//! Kept apart from `feeds.rs` (which only parses) so parsing stays testable without a network,
//! and apart from `mod.rs` (which only stores) so a refresh is: fetch -> parse -> store, with a
//! clear failure boundary at each step.

use super::feeds::Source;
use flate2::read::GzDecoder;
use std::io::Read;
use std::time::Duration;

/// Feeds are large and the app must stay usable while one is slow or hanging.
const TIMEOUT: Duration = Duration::from_secs(120);

/// A refresh outcome. `NotModified` matters: PhishTank's unkeyed budget is only a few requests
/// a day, so a cheap 304 is the difference between a working feed and a rate-limited one.
pub enum FetchOutcome {
    Fetched { body: String, etag: Option<String> },
    NotModified,
}

/// Downloads one feed, sending `If-None-Match` when a previous ETag is known.
pub async fn fetch(source: Source, previous_etag: Option<&str>) -> Result<FetchOutcome, String> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        // Identify honestly: these are community feeds run on donated resources, and an
        // anonymous scraper is exactly what gets an IP blocked.
        .user_agent(concat!("SentryMAil/", env!("CARGO_PKG_VERSION"), " (personal email client)"))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.get(source.url());
    if let Some(etag) = previous_etag {
        req = req.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;

    if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(FetchOutcome::NotModified);
    }
    if !resp.status().is_success() {
        // 403/429 from PhishTank normally means the unkeyed download budget is spent.
        return Err(format!("{} returned HTTP {}", source.as_str(), resp.status()));
    }

    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let body = if source.is_gzipped() {
        let mut out = String::new();
        GzDecoder::new(&bytes[..])
            .read_to_string(&mut out)
            .map_err(|e| format!("could not decompress {}: {e}", source.as_str()))?;
        out
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };

    Ok(FetchOutcome::Fetched { body, etag })
}
