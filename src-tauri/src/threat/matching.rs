//! Deciding whether a URL is known-phishing, and how confidently.
//!
//! Named `matching` rather than `match` because `match` is a Rust keyword.

/// How a URL matched the feeds. Exact is a statement of fact about that page; Host is an
/// inference about the domain, so it carries less weight downstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchKind {
    Exact,
    Host,
}

impl MatchKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MatchKind::Exact => "exact",
            MatchKind::Host => "host",
        }
    }
}

/// Hosts that serve many unrelated tenants. One phishing page here says nothing about the next
/// site on the same domain, so these are never promoted to host-level blocks - otherwise a
/// single phish on `sites.google.com` would condemn every Google Site a user is ever linked to.
const SHARED_HOSTING_SUFFIXES: &[&str] = &[
    "sites.google.com",
    "storage.googleapis.com",
    "firebaseapp.com",
    "web.app",
    "pages.dev",
    "workers.dev",
    "r2.dev",
    "github.io",
    "gitlab.io",
    "blogspot.com",
    "wordpress.com",
    "weebly.com",
    "wixsite.com",
    "glitch.me",
    "netlify.app",
    "vercel.app",
    "herokuapp.com",
    "azurewebsites.net",
    "s3.amazonaws.com",
    "sharepoint.com",
    "onedrive.live.com",
    "docs.google.com",
    "drive.google.com",
    "notion.site",
    "repl.co",
    "ngrok.io",
    "ngrok-free.app",
];

/// How many distinct listed URLs on one host before we call the host itself malicious.
///
/// One phishing page on a host is most often a *compromised* legitimate site - a hacked
/// WordPress install with a phishing kit dropped in a subdirectory. Blocking the whole domain
/// there would be wrong and highly visible. Several distinct phishing URLs on one host is a
/// much better signal that the host belongs to the attacker.
pub const HOST_PROMOTION_THRESHOLD: i64 = 3;

/// Whether a host may be promoted to a host-level block.
pub fn is_promotable_host(host: &str, distinct_url_count: i64) -> bool {
    if distinct_url_count < HOST_PROMOTION_THRESHOLD {
        return false;
    }
    !is_shared_hosting(host)
}

/// True when the host is (or sits under) a known multi-tenant hosting domain.
pub fn is_shared_hosting(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    SHARED_HOSTING_SUFFIXES
        .iter()
        .any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

/// The risk floor a set of matches imposes. A feed hit is fact, so the model may raise the risk
/// but must never lower it below this. The user's own `user_risk` still overrides everything.
pub fn risk_floor(kinds: &[MatchKind]) -> Option<&'static str> {
    if kinds.iter().any(|k| *k == MatchKind::Exact) {
        Some("danger")
    } else if kinds.contains(&MatchKind::Host) {
        Some("caution")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_url_on_a_host_never_promotes() {
        // The compromised-legitimate-site case.
        assert!(!is_promotable_host("charity-example.org", 1));
        assert!(!is_promotable_host("charity-example.org", 2));
    }

    #[test]
    fn several_urls_on_an_attacker_host_promote() {
        assert!(is_promotable_host("dbs-secure-verify.com", 3));
        assert!(is_promotable_host("dbs-secure-verify.com", 40));
    }

    #[test]
    fn shared_hosting_never_promotes_however_many_hits() {
        // The failure that would destroy trust in every warning the app gives.
        assert!(!is_promotable_host("sites.google.com", 500));
        assert!(!is_promotable_host("evil-kit.firebaseapp.com", 99));
        assert!(!is_promotable_host("someone.github.io", 50));
    }

    #[test]
    fn shared_hosting_matches_subdomains_not_lookalikes() {
        assert!(is_shared_hosting("foo.web.app"));
        assert!(is_shared_hosting("web.app"));
        // A lookalike domain is not the real shared host and must stay promotable.
        assert!(!is_shared_hosting("web.app.evil.com"));
        assert!(!is_shared_hosting("notweb.app"));
    }

    #[test]
    fn exact_match_floors_at_danger_host_at_caution() {
        assert_eq!(risk_floor(&[MatchKind::Exact]), Some("danger"));
        assert_eq!(risk_floor(&[MatchKind::Host]), Some("caution"));
        // Exact wins when both are present.
        assert_eq!(risk_floor(&[MatchKind::Host, MatchKind::Exact]), Some("danger"));
        assert_eq!(risk_floor(&[]), None);
    }
}
