//! Validation for meeting links the model reports.
//!
//! The model is allowed to find the link (it handles providers a fixed regex would miss), but
//! a small on-device model paraphrases and truncates. Two cheap checks catch that without
//! constraining what it can find:
//!
//! 1. the URL must appear **verbatim** in the thread text - it cannot be invented;
//! 2. its host must belong to a known meeting provider - it cannot be some unrelated link
//!    the model happened to latch onto.
//!
//! A wrong meeting link is worse than no link, so anything failing either check is dropped.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeetingProvider {
    GoogleMeet,
    Zoom,
    Teams,
    Webex,
    Whereby,
}

impl MeetingProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            MeetingProvider::GoogleMeet => "google_meet",
            MeetingProvider::Zoom => "zoom",
            MeetingProvider::Teams => "teams",
            MeetingProvider::Webex => "webex",
            MeetingProvider::Whereby => "whereby",
        }
    }
}

/// Trailing characters that are punctuation around a URL in prose rather than part of it.
const TRAILING_JUNK: &[char] = &['.', ',', ')', ']', '>', '"', '\'', ';', ':', '!', '?'];

/// Returns the cleaned URL and its provider when the link is trustworthy, else `None`.
pub fn validate_join_url(candidate: &str, thread_text: &str) -> Option<(String, MeetingProvider)> {
    let url = candidate.trim().trim_end_matches(TRAILING_JUNK);
    if url.is_empty() {
        return None;
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return None;
    }
    // Must occur in the thread as a *whole* URL, not merely as a substring: a truncated link
    // like ".../j/12345" is a substring of the real ".../j/1234567890" and would otherwise
    // sail through this check and be shown as joinable.
    if !occurs_as_whole_url(url, thread_text) {
        return None;
    }
    let provider = classify(url)?;
    Some((url.to_string(), provider))
}

/// True when `url` appears in `thread_text` as a complete URL token.
///
/// Each occurrence is extended to the surrounding run of non-whitespace, trailing prose
/// punctuation is stripped, and the result must equal `url` exactly. Substring equality is not
/// enough - see the truncation case in the tests.
fn occurs_as_whole_url(url: &str, thread_text: &str) -> bool {
    let mut from = 0usize;
    while let Some(rel) = thread_text[from..].find(url) {
        let start = from + rel;
        let tail = &thread_text[start..];
        let end = tail.find(char::is_whitespace).unwrap_or(tail.len());
        let token = tail[..end].trim_end_matches(TRAILING_JUNK);
        if token == url {
            return true;
        }
        // Advance past this occurrence; the same URL may appear again later in the thread.
        from = start + url.len();
        if from >= thread_text.len() {
            break;
        }
    }
    false
}

/// Recognizes the host of a known meeting provider. Matching is host-scoped, not a substring
/// search of the whole URL: `https://evil.example/?u=meet.google.com` must not pass.
fn classify(url: &str) -> Option<MeetingProvider> {
    let host = host_of(url)?;
    let host = host.to_ascii_lowercase();
    let is = |domain: &str| host == domain || host.ends_with(&format!(".{domain}"));

    if is("meet.google.com") {
        return Some(MeetingProvider::GoogleMeet);
    }
    if is("zoom.us") || is("zoom.com") {
        return Some(MeetingProvider::Zoom);
    }
    if is("teams.microsoft.com") || is("teams.live.com") {
        return Some(MeetingProvider::Teams);
    }
    if is("webex.com") {
        return Some(MeetingProvider::Webex);
    }
    if is("whereby.com") {
        return Some(MeetingProvider::Whereby);
    }
    None
}

fn host_of(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    // Strip userinfo ("user@host") and any port, so neither can smuggle a fake host past us.
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_real_link_present_in_the_thread() {
        let thread = "Great - here is the link: https://meet.google.com/abc-defg-hij see you then";
        let (url, p) = validate_join_url("https://meet.google.com/abc-defg-hij", thread).unwrap();
        assert_eq!(url, "https://meet.google.com/abc-defg-hij");
        assert_eq!(p, MeetingProvider::GoogleMeet);
    }

    #[test]
    fn rejects_a_link_not_present_in_the_thread() {
        // The exact failure this guard exists for: a plausible link the model invented.
        let thread = "Let's meet Thursday at 3pm.";
        assert!(validate_join_url("https://meet.google.com/xyz-abcd-efg", thread).is_none());
    }

    #[test]
    fn rejects_a_truncated_link() {
        let thread = "Join at https://zoom.us/j/1234567890 tomorrow";
        // Model dropped the last digits; the verbatim check catches it.
        assert!(validate_join_url("https://zoom.us/j/12345", thread).is_none());
    }

    #[test]
    fn accepts_a_link_that_appears_twice_in_the_thread() {
        let thread = "https://zoom.us/j/1234567890\nreminder: https://zoom.us/j/1234567890";
        assert!(validate_join_url("https://zoom.us/j/1234567890", thread).is_some());
    }

    #[test]
    fn rejects_a_link_extended_with_extra_path() {
        // The mirror of truncation: the model dropped a query string it should have kept.
        let thread = "Room: https://zoom.us/j/1234567890?pwd=secret";
        assert!(validate_join_url("https://zoom.us/j/1234567890", thread).is_none());
    }

    #[test]
    fn rejects_a_non_meeting_host_even_when_present() {
        let thread = "Agenda is at https://docs.google.com/document/d/123";
        assert!(validate_join_url("https://docs.google.com/document/d/123", thread).is_none());
    }

    #[test]
    fn host_matching_is_not_a_substring_search() {
        let evil = "https://evil.example.com/?redirect=meet.google.com/abc-defg-hij";
        let thread = format!("click {evil}");
        assert!(validate_join_url(evil, &thread).is_none());
    }

    #[test]
    fn userinfo_cannot_spoof_the_host() {
        let evil = "https://meet.google.com@evil.example/abc";
        let thread = format!("click {evil}");
        assert!(validate_join_url(evil, &thread).is_none());
    }

    #[test]
    fn accepts_subdomains_and_ports_of_known_providers() {
        let thread = "https://nus-edu.zoom.us/j/98765 is the room";
        let (_, p) = validate_join_url("https://nus-edu.zoom.us/j/98765", thread).unwrap();
        assert_eq!(p, MeetingProvider::Zoom);
    }

    #[test]
    fn strips_trailing_prose_punctuation() {
        let thread = "Join at https://whereby.com/standup.";
        let (url, _) = validate_join_url("https://whereby.com/standup.", thread).unwrap();
        assert_eq!(url, "https://whereby.com/standup");
    }

    #[test]
    fn rejects_non_http_schemes() {
        let thread = "mailto:someone@example.com";
        assert!(validate_join_url("mailto:someone@example.com", thread).is_none());
    }
}
