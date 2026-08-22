#[derive(Debug, Clone, PartialEq)]
pub enum UnsubUri {
    Https(String),
    Mailto(String),
}

/// Splits a "List-Unsubscribe" header value on commas, extracts each `<...>`-wrapped
/// URI, and classifies it as Https or Mailto. Entries that aren't wrapped in angle
/// brackets, or whose scheme isn't recognized, are skipped rather than erroring - a
/// malformed entry from one sender shouldn't break parsing of the others.
pub fn parse_list_unsubscribe_header(value: &str) -> Vec<UnsubUri> {
    value
        .split(',')
        .filter_map(|entry| {
            let entry = entry.trim();
            let start = entry.find('<')?;
            let end = entry.find('>')?;
            if start >= end {
                return None;
            }
            let uri = entry[start + 1..end].trim();
            if let Some(rest) = uri.strip_prefix("https://") {
                Some(UnsubUri::Https(format!("https://{rest}")))
            } else if let Some(rest) = uri.strip_prefix("mailto:") {
                Some(UnsubUri::Mailto(rest.to_string()))
            } else {
                None
            }
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct MailtoTarget {
    pub to: String,
    pub subject: Option<String>,
    pub body: Option<String>,
}

/// Parses a mailto URI's address plus optional `subject=`/`body=` query params
/// (percent-decoded). `uri` should already have the `mailto:` prefix stripped (as
/// `parse_list_unsubscribe_header` does).
pub fn parse_mailto(uri: &str) -> Option<MailtoTarget> {
    let (address, query) = match uri.split_once('?') {
        Some((addr, q)) => (addr, Some(q)),
        None => (uri, None),
    };
    let address = address.trim();
    if address.is_empty() {
        return None;
    }

    let mut subject = None;
    let mut body = None;
    if let Some(query) = query {
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            let decoded = percent_decode(value);
            match key {
                "subject" => subject = Some(decoded),
                "body" => body = Some(decoded),
                _ => {}
            }
        }
    }

    Some(MailtoTarget {
        to: address.to_string(),
        subject,
        body,
    })
}

/// Minimal percent-decoder for mailto query params (application/x-www-form-urlencoded
/// style `+` for space, plus `%XX` escapes). Invalid escapes are passed through as-is
/// rather than erroring, since this is best-effort metadata, not a security boundary.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    out.push(byte);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rfc8058_mixed_example() {
        let uris = parse_list_unsubscribe_header(
            "<https://example.com/unsub?id=abc123>, <mailto:unsub-abc123@example.com>",
        );
        assert_eq!(
            uris,
            vec![
                UnsubUri::Https("https://example.com/unsub?id=abc123".to_string()),
                UnsubUri::Mailto("unsub-abc123@example.com".to_string()),
            ]
        );
    }

    #[test]
    fn parses_https_only() {
        let uris = parse_list_unsubscribe_header("<https://example.com/unsub>");
        assert_eq!(uris, vec![UnsubUri::Https("https://example.com/unsub".to_string())]);
    }

    #[test]
    fn parses_mailto_only() {
        let uris = parse_list_unsubscribe_header("<mailto:unsub@example.com>");
        assert_eq!(uris, vec![UnsubUri::Mailto("unsub@example.com".to_string())]);
    }

    #[test]
    fn skips_malformed_and_unbracketed_entries() {
        assert_eq!(parse_list_unsubscribe_header(""), vec![]);
        assert_eq!(parse_list_unsubscribe_header("not a uri at all"), vec![]);
        assert_eq!(parse_list_unsubscribe_header("ftp://example.com/unsub"), vec![]);
    }

    #[test]
    fn parses_mailto_with_percent_encoded_params() {
        let target = parse_mailto("unsub@example.com?subject=Please%20unsubscribe&body=stop").unwrap();
        assert_eq!(target.to, "unsub@example.com");
        assert_eq!(target.subject.as_deref(), Some("Please unsubscribe"));
        assert_eq!(target.body.as_deref(), Some("stop"));
    }

    #[test]
    fn parses_mailto_with_no_params() {
        let target = parse_mailto("unsub@example.com").unwrap();
        assert_eq!(target.to, "unsub@example.com");
        assert_eq!(target.subject, None);
        assert_eq!(target.body, None);
    }

    #[test]
    fn rejects_empty_mailto_address() {
        assert_eq!(parse_mailto("?subject=x"), None);
        assert_eq!(parse_mailto(""), None);
    }
}
