//! URL canonicalisation shared by feed ingestion and email scanning.
//!
//! Both sides **must** use this same function. If a feed stores
//! `http://Evil.example.com/Login/` and an email is scanned as
//! `http://evil.example.com/login`, matching silently fails and the whole feature quietly does
//! nothing - the worst kind of bug in a security control, because it looks like it works.

/// Normalises a URL for equality comparison, or returns `None` if it is not a usable http(s) URL.
///
/// Deliberately conservative: the query string is preserved, because phishing URLs routinely
/// carry their payload there (`?id=8823`, `?email=victim@x.com`) and stripping it would collapse
/// distinct phishing pages onto one entry.
pub fn canonicalize(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches(|c: char| matches!(c, '.' | ',' | ')' | ']' | '>' | '"' | '\'' | ';' | '!' | '?'));
    if trimmed.is_empty() {
        return None;
    }

    let url = reqwest::Url::parse(trimmed).ok()?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return None,
    }
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }

    // Default ports are noise: http://x.com:80/a and http://x.com/a are the same page.
    let port = match (url.port(), url.scheme()) {
        (Some(80), "http") | (Some(443), "https") => String::new(),
        (Some(p), _) => format!(":{p}"),
        (None, _) => String::new(),
    };

    // A bare "/" carries no information; anything deeper does and is kept verbatim (case
    // included - paths are case-sensitive on most servers).
    let path = match url.path() {
        "" | "/" => "",
        p => p,
    };

    let query = url.query().map(|q| format!("?{q}")).unwrap_or_default();

    // The fragment never reaches the server, so it cannot distinguish two pages.
    Some(format!("{}://{}{}{}{}", url.scheme(), host, port, path, query))
}

/// The lowercased host of a URL, for host-level matching.
pub fn host_of(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The property the whole feature rests on: however a URL is written in an email, it must
    /// canonicalise to whatever the feed stored.
    #[test]
    fn feed_and_email_spellings_agree() {
        let feed = canonicalize("http://Evil.Example.com:80/Login.php?id=8823").unwrap();
        let in_email = canonicalize("http://evil.example.com/Login.php?id=8823").unwrap();
        assert_eq!(feed, in_email);
    }

    #[test]
    fn host_case_and_trailing_dot_collapse() {
        assert_eq!(
            canonicalize("https://EVIL.example.com./x").unwrap(),
            canonicalize("https://evil.example.com/x").unwrap()
        );
    }

    #[test]
    fn default_ports_collapse_but_others_do_not() {
        assert_eq!(
            canonicalize("https://a.com:443/x").unwrap(),
            canonicalize("https://a.com/x").unwrap()
        );
        assert_ne!(
            canonicalize("https://a.com:8443/x").unwrap(),
            canonicalize("https://a.com/x").unwrap()
        );
    }

    #[test]
    fn fragment_is_dropped_but_query_is_kept() {
        assert_eq!(
            canonicalize("https://a.com/x#section").unwrap(),
            canonicalize("https://a.com/x").unwrap()
        );
        // Two phishing pages that differ only by query must stay distinct.
        assert_ne!(
            canonicalize("https://a.com/x?id=1").unwrap(),
            canonicalize("https://a.com/x?id=2").unwrap()
        );
    }

    #[test]
    fn bare_root_slash_collapses() {
        assert_eq!(
            canonicalize("https://a.com/").unwrap(),
            canonicalize("https://a.com").unwrap()
        );
    }

    #[test]
    fn path_case_is_preserved() {
        // Paths are case-sensitive on most servers; folding them would merge distinct pages.
        assert_ne!(
            canonicalize("https://a.com/Login").unwrap(),
            canonicalize("https://a.com/login").unwrap()
        );
    }

    #[test]
    fn trailing_prose_punctuation_is_stripped() {
        assert_eq!(
            canonicalize("https://a.com/x.").unwrap(),
            canonicalize("https://a.com/x").unwrap()
        );
    }

    #[test]
    fn rejects_non_http_schemes_and_junk() {
        assert!(canonicalize("mailto:a@b.com").is_none());
        assert!(canonicalize("javascript:alert(1)").is_none());
        assert!(canonicalize("not a url").is_none());
        assert!(canonicalize("").is_none());
    }

    #[test]
    fn host_of_lowercases() {
        assert_eq!(host_of("https://EVIL.Example.com/x").unwrap(), "evil.example.com");
        assert!(host_of("mailto:a@b.com").is_none());
    }
}
