//! Fetching an email's remote images on the user's explicit request.
//!
//! The sandboxed iframe that renders mail carries `connect-src 'none'` and `img-src data: cid:`,
//! so it can never load a remote image itself - and that stays true. Instead the user asks for
//! the pictures, we fetch them here, and hand them back as data URIs for the same rewrite the
//! inline `cid:` images already go through. The frame never touches the network under any bug.
//!
//! Fetching in Rust also buys what a widened CSP could not: no cookie jar (reqwest's `cookies`
//! feature is deliberately not enabled - do not enable it), no `Referer`, an enforced timeout
//! and byte cap, a content-type check, and a per-URL failure reason we can actually show.

use serde::Serialize;
use std::net::IpAddr;

/// One remote image, or the reason it is missing.
#[derive(Debug, Serialize)]
pub struct RemoteImageDto {
    /// The URL exactly as the frontend sent it, so it can string-replace against the HTML.
    pub url: String,
    pub mime_type: Option<String>,
    pub data_base64: Option<String>,
    /// Plain language, rendered to the user as-is; None on success.
    pub error: Option<String>,
}

pub const MAX_URLS: usize = 60;
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: usize = 16 * 1024 * 1024;
const PER_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
const TOTAL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(25);
const MAX_REDIRECTS: usize = 3;

pub const ERR_TOO_MANY: &str = "this email has too many pictures to show them all";
pub const ERR_BUDGET: &str = "there was not room to show this picture";
pub const ERR_TIMEOUT: &str = "took too long to load";
pub const ERR_SERVER: &str = "the sender's server did not send the picture";
pub const ERR_NOT_IMAGE: &str = "that link was not a picture";
pub const ERR_TOO_BIG: &str = "that picture is too large to show";
pub const ERR_BLOCKED: &str = "that picture is at an address we will not open";

/// True for addresses that must never be reachable from an email's markup: loopback, private
/// ranges, link-local (which includes the cloud metadata endpoint), and IPv6 ULA.
fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.octets()[0] == 0
                // 100.64.0.0/10 carrier-grade NAT
                || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                // fc00::/7 unique local
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // fe80::/10 link local
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // IPv4-mapped addresses inherit the v4 rules
                || v6.to_ipv4_mapped().is_some_and(|m| is_blocked_ip(IpAddr::V4(m)))
        }
    }
}

/// Parses and screens a URL taken from email markup.
///
/// `http:` is allowed alongside `https:` on purpose: a lot of real marketing mail still hosts
/// images on plain http, and a "Show pictures" button that silently fails on half of them is
/// worse than a plaintext GET the user explicitly asked for - to a host that already knows they
/// opened the mail the moment the request lands.
pub fn validate_image_url(raw: &str) -> Result<reqwest::Url, &'static str> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| ERR_BLOCKED)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ERR_BLOCKED);
    }
    // A host given as a bare IP literal is screened here; hostnames are screened after
    // resolution, in `resolves_to_public`.
    if let Some(host) = url.host_str() {
        let literal = host.trim_start_matches('[').trim_end_matches(']');
        if let Ok(ip) = literal.parse::<IpAddr>() {
            if is_blocked_ip(ip) {
                return Err(ERR_BLOCKED);
            }
        }
    } else {
        return Err(ERR_BLOCKED);
    }
    Ok(url)
}

/// Resolves the host and screens every address it maps to.
///
/// Known residual risk: this lookup and the one reqwest performs when connecting are separate,
/// so a hostile DNS server can answer differently for each (classic rebinding). Closing that
/// needs a custom resolver or connecting to a pre-validated socket address with a `Host`
/// override. Accepted here because the worst case is a blind GET to a local address whose bytes
/// are only ever drawn as an image inside a script-less sandbox - nothing is read back out.
async fn resolves_to_public(url: &reqwest::Url) -> bool {
    let host = match url.host_str() {
        Some(h) => h,
        None => return false,
    };
    if host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>().is_ok() {
        return true; // already screened as a literal
    }
    let port = url.port_or_known_default().unwrap_or(80);
    match tokio::net::lookup_host((host, port)).await {
        Ok(addrs) => {
            let mut any = false;
            for addr in addrs {
                any = true;
                if is_blocked_ip(addr.ip()) {
                    return false;
                }
            }
            any
        }
        Err(_) => false,
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(PER_REQUEST_TIMEOUT)
        // Redirects are followed by hand in `fetch_one` so that every hop goes through the
        // *same* screen as the original URL - including DNS resolution. reqwest's redirect
        // policy callback is synchronous, so it cannot resolve a hostname, and a policy that
        // only rejected IP literals would happily follow `http://intranet.evil.test/` whose
        // A record points at 10.0.0.5.
        .redirect(reqwest::redirect::Policy::none())
        // No cookie store is configured (the `cookies` feature is off), and no Referer is sent.
        .user_agent("SentryMail")
        .build()
        .map_err(|e| e.to_string())
}

/// Screens a URL fully: scheme, IP literals, and the addresses its hostname resolves to.
async fn screen(raw: &str) -> Result<reqwest::Url, &'static str> {
    let url = validate_image_url(raw)?;
    if !resolves_to_public(&url).await {
        return Err(ERR_BLOCKED);
    }
    Ok(url)
}

async fn fetch_one(http: &reqwest::Client, url: reqwest::Url, remaining: usize) -> Result<(String, Vec<u8>), &'static str> {
    let mut current = url;
    let mut resp;
    let mut hops = 0;
    loop {
        resp = http
            .get(current.clone())
            .header(reqwest::header::ACCEPT, "image/*")
            .send()
            .await
            .map_err(|e| if e.is_timeout() { ERR_TIMEOUT } else { ERR_SERVER })?;
        if !resp.status().is_redirection() {
            break;
        }
        if hops >= MAX_REDIRECTS {
            return Err(ERR_SERVER);
        }
        let location = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(ERR_SERVER)?;
        // Relative redirects are legal, so resolve against the URL we just asked for, then put
        // the result through the full screen again - resolution included.
        let next = current.join(location).map_err(|_| ERR_BLOCKED)?;
        current = screen(next.as_str()).await?;
        hops += 1;
    }
    if !resp.status().is_success() {
        return Err(ERR_SERVER);
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().to_lowercase())
        .unwrap_or_default();
    if !mime.starts_with("image/") {
        return Err(ERR_NOT_IMAGE);
    }
    // SVG can carry script and external references. Inert inside <img>, but refused anyway -
    // it is vanishingly rare in real mail and not worth the exception.
    if mime == "image/svg+xml" {
        return Err(ERR_NOT_IMAGE);
    }
    // Read in chunks and abort past the cap rather than trusting Content-Length.
    let cap = MAX_IMAGE_BYTES.min(remaining);
    let mut body: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > cap {
                    return Err(if cap < MAX_IMAGE_BYTES { ERR_BUDGET } else { ERR_TOO_BIG });
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => return Err(if e.is_timeout() { ERR_TIMEOUT } else { ERR_SERVER }),
        }
    }
    if body.is_empty() {
        return Err(ERR_SERVER);
    }
    Ok((mime, body))
}

/// Fetches every URL the caller asked for, in order, within the shared budget and deadline.
pub async fn fetch_remote_images(urls: Vec<String>) -> Result<Vec<RemoteImageDto>, String> {
    use base64::Engine as _;
    let http = client()?;
    let started = std::time::Instant::now();
    let mut out = Vec::with_capacity(urls.len());
    let mut spent: usize = 0;

    for (i, raw) in urls.into_iter().enumerate() {
        let fail = |url: String, why: &str| RemoteImageDto {
            url,
            mime_type: None,
            data_base64: None,
            error: Some(why.to_string()),
        };
        if i >= MAX_URLS {
            out.push(fail(raw, ERR_TOO_MANY));
            continue;
        }
        if started.elapsed() > TOTAL_DEADLINE {
            out.push(fail(raw, ERR_TIMEOUT));
            continue;
        }
        if spent >= MAX_TOTAL_BYTES {
            out.push(fail(raw, ERR_TOO_MANY));
            continue;
        }
        let url = match screen(&raw).await {
            Ok(u) => u,
            Err(why) => {
                out.push(fail(raw, why));
                continue;
            }
        };
        match fetch_one(&http, url, MAX_TOTAL_BYTES - spent).await {
            Ok((mime, bytes)) => {
                spent += bytes.len();
                out.push(RemoteImageDto {
                    url: raw,
                    mime_type: Some(mime),
                    data_base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
                    error: None,
                });
            }
            Err(why) => out.push(fail(raw, why)),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_http_schemes() {
        for raw in ["file:///etc/passwd", "javascript:alert(1)", "data:image/png;base64,AAAA", "cid:logo123", "ftp://x.test/a.png"] {
            assert!(validate_image_url(raw).is_err(), "should reject {raw}");
        }
    }

    #[test]
    fn rejects_loopback_and_private_literals() {
        for raw in [
            "http://127.0.0.1/x.png",
            "http://10.0.0.5/x.png",
            "http://192.168.1.1/x.png",
            "http://172.16.0.1/x.png",
            "http://[::1]/x.png",
            "http://0.0.0.0/x.png",
            "http://[fc00::1]/x.png",
            "http://[fe80::1]/x.png",
        ] {
            assert!(validate_image_url(raw).is_err(), "should reject {raw}");
        }
    }

    #[test]
    fn rejects_the_cloud_metadata_endpoint() {
        assert!(validate_image_url("http://169.254.169.254/latest/meta-data").is_err());
    }

    #[test]
    fn rejects_ipv4_mapped_loopback() {
        assert!(validate_image_url("http://[::ffff:127.0.0.1]/x.png").is_err());
    }

    #[test]
    fn accepts_ordinary_public_urls() {
        assert!(validate_image_url("https://cdn.example.com/a.png?v=2").is_ok());
        // http is deliberately allowed too - see the doc comment.
        assert!(validate_image_url("http://cdn.example.com/a.png").is_ok());
    }

    #[test]
    fn trims_surrounding_whitespace() {
        assert!(validate_image_url("  https://cdn.example.com/a.png  ").is_ok());
    }
}
