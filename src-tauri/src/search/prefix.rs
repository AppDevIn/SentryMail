// Conservative vs. the ~2048-token embedding context (no generation budget needed here,
// unlike triage's separate prompt/max_tokens split).
const MAX_EMBED_CHARS: usize = 6000;

/// Document-side embedding prompt for an email being indexed. EmbeddingGemma's prompting
/// is asymmetric between documents and queries - getting this backwards silently degrades
/// retrieval quality, so this is a separately-named function from `query_text`, not a
/// shared function with an easy-to-flip boolean flag.
pub fn document_text(title: Option<&str>, body: &str) -> String {
    let title = title.map(str::trim).filter(|t| !t.is_empty()).unwrap_or("none");
    format!("title: {title} | text: {}", truncate_chars(body, MAX_EMBED_CHARS))
}

/// Query-side embedding prompt for a user's search box input.
pub fn query_text(query: &str) -> String {
    format!("task: search result | query: {}", truncate_chars(query, MAX_EMBED_CHARS))
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_text_uses_title_and_body() {
        assert_eq!(
            document_text(Some("Lunch"), "Are you free at noon?"),
            "title: Lunch | text: Are you free at noon?"
        );
    }

    #[test]
    fn document_text_falls_back_to_none_for_missing_title() {
        assert_eq!(document_text(None, "body"), "title: none | text: body");
        assert_eq!(document_text(Some("   "), "body"), "title: none | text: body");
        assert_eq!(document_text(Some(""), "body"), "title: none | text: body");
    }

    #[test]
    fn query_text_uses_search_result_task() {
        assert_eq!(query_text("flight confirmation"), "task: search result | query: flight confirmation");
    }

    #[test]
    fn truncates_oversized_body() {
        let long_body = "x".repeat(10_000);
        let text = document_text(Some("t"), &long_body);
        assert!(text.len() < long_body.len());
    }
}
