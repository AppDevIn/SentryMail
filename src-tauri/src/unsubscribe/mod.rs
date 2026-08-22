mod parse;
pub use parse::{parse_list_unsubscribe_header, parse_mailto, MailtoTarget, UnsubUri};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UnsubscribeMethod {
    OneClickPost { url: String },
    Browser { url: String },
    Mailto {
        to: String,
        subject: Option<String>,
        body: Option<String>,
    },
    Unavailable,
}

/// Decides how (if at all) an email can be unsubscribed from, purely from its stored
/// headers - never from anything the frontend supplies, so a compromised/buggy renderer
/// can't direct the backend to POST or send to an arbitrary attacker-chosen target.
///
/// - An `https://` URI plus a confirmed `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
///   header is the only case safe to auto-POST (RFC 8058 one-click).
/// - An `https://` URI without that header is *not* confirmed one-click-compliant, so it's
///   opened as a normal webpage instead of blindly POSTed.
/// - A `mailto:` URI (no usable https URI) requires actually sending an email - see
///   `GmailClient::send_draft`, this app's one deliberate send-capable path.
pub fn classify(list_unsubscribe: Option<&str>, list_unsubscribe_post: bool) -> UnsubscribeMethod {
    let Some(header) = list_unsubscribe else {
        return UnsubscribeMethod::Unavailable;
    };
    let uris = parse_list_unsubscribe_header(header);

    let https_url = uris.iter().find_map(|u| match u {
        UnsubUri::Https(url) => Some(url.clone()),
        UnsubUri::Mailto(_) => None,
    });
    if let Some(url) = https_url {
        return if list_unsubscribe_post {
            UnsubscribeMethod::OneClickPost { url }
        } else {
            UnsubscribeMethod::Browser { url }
        };
    }

    let mailto = uris.iter().find_map(|u| match u {
        UnsubUri::Mailto(addr) => parse_mailto(addr),
        UnsubUri::Https(_) => None,
    });
    if let Some(MailtoTarget { to, subject, body }) = mailto {
        return UnsubscribeMethod::Mailto { to, subject, body };
    }

    UnsubscribeMethod::Unavailable
}

/// Fires the RFC 8058 one-click POST: a plain HTTPS request unrelated to the Gmail API
/// or OAuth (no auth header, no cookies, no other context sent) - exactly as the RFC
/// requires. Must only be called after explicit user confirmation in the UI, never
/// automatically during sync.
pub async fn one_click_post(url: &str) -> Result<(), String> {
    reqwest::Client::new()
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("List-Unsubscribe=One-Click")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_click_when_https_and_post_header_present() {
        let method = classify(Some("<https://x.com/unsub?id=1>"), true);
        assert_eq!(
            method,
            UnsubscribeMethod::OneClickPost { url: "https://x.com/unsub?id=1".to_string() }
        );
    }

    #[test]
    fn browser_when_https_but_no_post_header() {
        let method = classify(Some("<https://x.com/unsub?id=1>"), false);
        assert_eq!(
            method,
            UnsubscribeMethod::Browser { url: "https://x.com/unsub?id=1".to_string() }
        );
    }

    #[test]
    fn mailto_when_no_https_uri_present() {
        let method = classify(Some("<mailto:unsub@x.com?subject=stop>"), false);
        assert_eq!(
            method,
            UnsubscribeMethod::Mailto {
                to: "unsub@x.com".to_string(),
                subject: Some("stop".to_string()),
                body: None,
            }
        );
    }

    #[test]
    fn unavailable_when_no_header() {
        assert_eq!(classify(None, false), UnsubscribeMethod::Unavailable);
    }

    #[test]
    fn unavailable_when_header_has_nothing_usable() {
        assert_eq!(classify(Some("garbage, no uris here"), true), UnsubscribeMethod::Unavailable);
    }

    #[test]
    fn prefers_https_even_when_mailto_listed_first() {
        let method = classify(
            Some("<mailto:unsub@x.com>, <https://x.com/unsub>"),
            true,
        );
        assert_eq!(
            method,
            UnsubscribeMethod::OneClickPost { url: "https://x.com/unsub".to_string() }
        );
    }
}
