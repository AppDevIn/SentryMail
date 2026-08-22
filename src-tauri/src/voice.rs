//! Spoken-command interpretation with the on-device model.
//!
//! The frontend (src/voice.ts) understands most phrasings itself. When it can't place a phrase it
//! sends the transcript here, and the local model maps it to one of a fixed set of intents under a
//! GBNF grammar, so the answer is always a small, parseable JSON object.

use serde::{Deserialize, Serialize};

use crate::llm::{grammar, LlmHandle};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VoiceIntent {
    /// One of the grammar's intent names ("read", "search", "open_match", ... or "unknown").
    pub intent: String,
    /// Search words, a 1-based position (for open_number), or sender/topic words (for open_match).
    pub query: String,
}

const INSTRUCTIONS: &str = r#"You are the voice-command interpreter inside a private email app used by older people. The user spoke one short request; speech recognition may have garbled a word or two. Decide what they want. Be generous: understand the meaning, not the exact words, but never invent a request that isn't there.

Intents:
- read: read the open email's message aloud, or read out what's new in the inbox ("read it to me", "what does it say", "my eyes are tired", "what's new")
- read_summary: say what the open email is about in short (the summary) ("what's this about", "give me the gist")
- read_details: say who the open email is from, when it arrived, its subject ("who sent this", "when did this come")
- stop: stop talking
- reply: start a reply to the open email; query = what they want the reply to say, if they said it ("reply saying thanks, I'll publish it" -> "thanks, I'll publish it"), else ""
- back: leave the open email / return to the list
- settings: open the settings
- mark_read / mark_unread: change the read state of the open email
- done / reopen: mark the open email handled, or undo that
- search: look for emails; query = the words to search for (topic, sender name), without words like "emails", "about", "from"
- clear_search: clear the current search
- open_number: open the Nth email in the list; query = N as digits ("1" for first/latest/top, "last" for the last one)
- open_match: open the email from a person or about a topic; query = that name or topic
- next / previous: move to the next or previous email
- sync: check for new mail
- quarantine / inbox: show that folder
- help: the user asks what they can say
- unknown: nothing above fits

Respond with ONLY a JSON object: {"intent": "...", "query": "..."} (query is "" unless the intent needs one)."#;

/// Prompt for the Gemma chat template.
pub fn build_voice_prompt(transcript: &str, email_open: bool) -> String {
    let context = if email_open {
        "An email is currently open on screen."
    } else {
        "The inbox list is on screen (no email is open)."
    };
    let transcript: String = transcript.chars().take(400).collect();
    format!(
        "<start_of_turn>user\n{INSTRUCTIONS}\n\nContext: {context}\nThe user said: \"{transcript}\"\n<end_of_turn>\n<start_of_turn>model\n"
    )
}

/// Parses the grammar-constrained answer; anything unparseable counts as "unknown".
pub fn parse_voice_intent(raw: &str) -> VoiceIntent {
    let start = raw.find('{');
    let end = raw.rfind('}');
    let json = match (start, end) {
        (Some(s), Some(e)) if e >= s => &raw[s..=e],
        _ => raw,
    };
    serde_json::from_str::<VoiceIntent>(json).unwrap_or(VoiceIntent {
        intent: "unknown".to_string(),
        query: String::new(),
    })
}

pub async fn interpret(handle: &LlmHandle, transcript: &str, email_open: bool) -> Result<VoiceIntent, String> {
    let prompt = build_voice_prompt(transcript, email_open);
    let raw = handle
        .generate_with(prompt, 64, grammar::VOICE_GBNF, grammar::VOICE_GRAMMAR_ROOT)
        .await?;
    Ok(parse_voice_intent(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_intent_json() {
        let r = parse_voice_intent(r#"{"intent": "search", "query": "dentist"}"#);
        assert_eq!(r.intent, "search");
        assert_eq!(r.query, "dentist");
    }

    #[test]
    fn garbage_is_unknown() {
        assert_eq!(parse_voice_intent("not json").intent, "unknown");
    }

    #[test]
    fn prompt_mentions_context_and_transcript() {
        let p = build_voice_prompt("my eyes are tired", true);
        assert!(p.contains("An email is currently open"));
        assert!(p.contains("my eyes are tired"));
        assert!(p.ends_with("<start_of_turn>model\n"));
    }
}
