mod prompt;
pub use prompt::{build_label_prompt, build_meeting_prompt, build_reply_prompt, build_reply_prompt_with, build_summary_prompt, build_triage_prompt, PromptInput, ThreadMessage};

use crate::llm::grammar::{REPLY_GBNF, REPLY_GRAMMAR_ROOT, SUMMARY_GBNF, SUMMARY_GRAMMAR_ROOT};
use crate::llm::LlmHandle;
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::sync::Mutex;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawType {
    ActionNeeded,
    Fyi,
    ScamRisk,
    Personal,
    NewsletterPromo,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawPriority {
    High,
    Medium,
    Low,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawRisk {
    Safe,
    Caution,
    Danger,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawSignal {
    UrgencyPressure,
    MoneyRequest,
    CredentialRequest,
    SenderMismatch,
    SuspiciousLinks,
    EmotionalManipulation,
    SecrecyRequest,
    InconsistentFormatting,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RawAction {
    DraftReply {
        draft_reply: String,
        verify_first: Option<String>,
    },
    Warning {
        warning: String,
        next_step: String,
    },
    None {},
}

#[derive(Debug, Deserialize)]
struct RawTriageOutput {
    #[serde(rename = "type")]
    type_: RawType,
    priority: RawPriority,
    summary: String,
    risk: RawRisk,
    signals: Vec<RawSignal>,
    risk_explanation: String,
    action: RawAction,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TriageResult {
    pub email_id: i64,
    #[serde(rename = "type")]
    pub type_: String,
    pub priority: String,
    pub summary: String,
    pub risk: String,
    pub signals_json: String,
    pub risk_explanation: String,
    pub draft_reply: Option<String>,
    pub next_step_warning: Option<String>,
    pub triage_status: String, // "ok" | "parse_error"
    pub model_version: String,
    /// The user's override of `risk`, if they set one ("safe" | "caution" | "danger").
    pub user_risk: Option<String>,
    /// The user marked this email as handled.
    pub done: bool,
}

/// Bump whenever the prompt or grammar contract changes, so stale rows can be
/// identified/re-triaged later if needed.
/// v2: prompt now carries To/Cc addressing, strips quoted history, and asks for real
/// email layout in drafts. Results tagged v1 are shown as outdated in the UI.
/// v3: headline-style summaries.
pub const MODEL_VERSION: &str = "gemma-triage-v3";

pub async fn triage_email(
    db: &Mutex<Connection>,
    llm: &LlmHandle,
    email_id: i64,
    user_email: &str,
) -> Result<TriageResult, String> {
    let (sender, subject, body_text, to_addrs, cc_addrs) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT sender, subject, body_text, to_addrs, cc_addrs FROM emails WHERE id = ?1",
            params![email_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                ))
            },
        )
        .map_err(|e| e.to_string())?
    };

    let prompt = build_triage_prompt(&PromptInput {
        sender: &sender,
        to: &to_addrs,
        cc: &cc_addrs,
        subject: &subject,
        body_text: &body_text,
        user_email,
    });
    let raw_output = llm.generate(prompt, 700).await?;

    let result = match serde_json::from_str::<RawTriageOutput>(&raw_output) {
        Ok(parsed) => map_result(email_id, parsed),
        Err(_) => parse_error_result(email_id),
    };

    persist(db, &result)?;
    Ok(result)
}

#[derive(Debug, Deserialize)]
struct RawReplyOutput {
    draft_reply: String,
}

#[derive(Debug, Deserialize)]
struct RawSummaryOutput {
    summary: String,
}

#[derive(Debug, Deserialize)]
struct RawLabelOutput {
    labels: Vec<String>,
}

fn gbnf_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// GBNF grammar that only admits `{"labels": [...]}` drawn from the given label names.
pub fn label_grammar(names: &[String]) -> String {
    let alts = names
        .iter()
        .map(|n| {
            // The model emits the name inside a JSON string: JSON-escape it first, then
            // escape that for the GBNF literal.
            let json = n.replace('\\', "\\\\").replace('"', "\\\"");
            format!("\"\\\"{}\\\"\"", gbnf_escape(&json))
        })
        .collect::<Vec<_>>()
        .join(" | ");
    format!(
        "root ::= \"{{\" ws \"\\\"labels\\\":\" ws \"[\" ws (label (ws \",\" ws label)*)? ws \"]\" ws \"}}\"\n\
         label ::= {alts}\n\
         ws ::= [ \\t\\n]*\n"
    )
}

/// Asks the model which of the described labels (name, description) fit the email.
/// Returns matching label names (deduplicated, only ones from the list).
pub async fn suggest_labels(
    db: &Mutex<Connection>,
    llm: &LlmHandle,
    email_id: i64,
    user_email: &str,
    labels: &[(String, String)],
) -> Result<Vec<String>, String> {
    if labels.is_empty() {
        return Ok(Vec::new());
    }
    let (sender, subject, body_text, to_addrs, cc_addrs) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT sender, subject, body_text, to_addrs, cc_addrs FROM emails WHERE id = ?1",
            params![email_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                ))
            },
        )
        .map_err(|e| e.to_string())?
    };
    let prompt = build_label_prompt(
        labels,
        &PromptInput {
            sender: &sender,
            to: &to_addrs,
            cc: &cc_addrs,
            subject: &subject,
            body_text: &body_text,
            user_email,
        },
    );
    let names: Vec<String> = labels.iter().map(|(n, _)| n.clone()).collect();
    let raw = llm.generate_with(prompt, 120, label_grammar(&names), "root").await?;
    let parsed: RawLabelOutput =
        serde_json::from_str(&raw).map_err(|e| format!("unreadable label answer ({e}); try again"))?;
    let mut out = Vec::new();
    for l in parsed.labels {
        if names.contains(&l) && !out.contains(&l) {
            out.push(l);
        }
    }
    Ok(out)
}

/// Stable 64-bit FNV-1a hash, hex-encoded - the cache key for message summaries.
pub fn content_hash(sender: &str, text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in sender.as_bytes().iter().chain(b"\0").chain(text.as_bytes()) {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// One-line summary of an arbitrary message (used for earlier messages in a thread).
/// Cached by content hash; `allow_generate = false` only consults the cache.
pub async fn summarize_message(
    db: &Mutex<Connection>,
    llm: Option<&LlmHandle>,
    sender: &str,
    text: &str,
    allow_generate: bool,
) -> Result<Option<String>, String> {
    let key = content_hash(sender, text);
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        if let Ok(cached) = conn.query_row(
            "SELECT summary FROM message_summaries WHERE content_hash = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        ) {
            return Ok(Some(cached));
        }
    }
    if !allow_generate {
        return Ok(None);
    }
    let llm = llm.ok_or("model not loaded - call load_model first")?;
    if text.trim().is_empty() {
        return Ok(Some("(no text)".to_string()));
    }
    let prompt = build_summary_prompt(sender, text);
    let raw = llm.generate_with(prompt, 60, SUMMARY_GBNF, SUMMARY_GRAMMAR_ROOT).await?;
    let parsed: RawSummaryOutput =
        serde_json::from_str(&raw).map_err(|e| format!("unreadable summary ({e}); try again"))?;
    let summary = parsed.summary.trim().to_string();
    if summary.is_empty() {
        return Err("the model returned an empty summary; try again".to_string());
    }
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO message_summaries (content_hash, summary, model_version) VALUES (?1, ?2, ?3)",
        params![key, summary, MODEL_VERSION],
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(summary))
}

/// Drafts a reply on demand (for emails triage did not draft for). Refuses DANGER emails.
/// The draft is returned to the UI, not persisted - the user decides what to do with it.
pub async fn draft_reply(
    db: &Mutex<Connection>,
    llm: &LlmHandle,
    email_id: i64,
    user_email: &str,
    instructions: Option<&str>,
    previous_draft: Option<&str>,
) -> Result<String, String> {
    let (sender, subject, body_text, to_addrs, cc_addrs, risk) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT e.sender, e.subject, e.body_text, e.to_addrs, e.cc_addrs, COALESCE(t.user_risk, t.risk)
             FROM emails e LEFT JOIN triage_results t ON t.email_id = e.id
             WHERE e.id = ?1",
            params![email_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?
    };
    if risk.as_deref() == Some("danger") {
        return Err("Refusing to draft a reply to an email flagged as DANGER risk".to_string());
    }

    let prompt = build_reply_prompt_with(
        &PromptInput {
            sender: &sender,
            to: &to_addrs,
            cc: &cc_addrs,
            subject: &subject,
            body_text: &body_text,
            user_email,
        },
        instructions,
        previous_draft,
    );
    let raw = llm.generate_with(prompt, 400, REPLY_GBNF, REPLY_GRAMMAR_ROOT).await?;
    let parsed: RawReplyOutput = serde_json::from_str(&raw)
        .map_err(|e| format!("the model returned an unreadable draft ({e}); try again"))?;
    let draft = normalize_draft(&parsed.draft_reply);
    if draft.trim().is_empty() {
        return Err("the model returned an empty draft; try again".to_string());
    }
    Ok(draft)
}

/// Small on-device models often emit a reply as one run-on line ("Hi A, thanks. ... Best
/// regards, B"). This restores conventional email layout without changing the words:
/// greeting on its own line, and a sign-off that appears mid-line moved onto its own
/// lines. Anything already multi-line is left as written (apart from collapsing 3+ blank
/// lines).
pub fn normalize_draft(draft: &str) -> String {
    const GREETINGS: [&str; 5] = ["Hi ", "Hello ", "Hey ", "Dear ", "Good "];
    const SIGN_OFFS: [&str; 12] = [
        "Best regards,",
        "Kind regards,",
        "Warm regards,",
        "Best wishes,",
        "Regards,",
        "Best,",
        "Thanks,",
        "Thank you,",
        "Many thanks,",
        "Cheers,",
        "Sincerely,",
        "Talk soon,",
    ];

    let mut s = draft.replace("\r\n", "\n").trim().to_string();
    if s.is_empty() {
        return s;
    }

    // 1. Greeting: "Hi Dana, thanks for..." -> "Hi Dana,\n\nthanks for..."
    let first_line_end = s.find('\n').unwrap_or(s.len());
    if GREETINGS.iter().any(|g| s.starts_with(g)) {
        if let Some(comma) = s[..first_line_end].find(',') {
            if comma < 60 && s[comma + 1..first_line_end].trim_start().len() > 0 {
                let rest = s[comma + 1..].trim_start().to_string();
                s = format!("{},\n\n{}", &s[..comma], rest);
            }
        }
    }

    // 2. Sign-off that shares a line with body text: move it (and the name after it) onto
    //    their own lines, but only when what follows looks like a name, not a sentence.
    for token in SIGN_OFFS {
        let mut search_from = 0;
        while let Some(rel) = s[search_from..].find(token) {
            let idx = search_from + rel;
            let after = s[idx + token.len()..].trim_start();
            let looks_like_sign_off = after.len() <= 40
                && !after.contains(". ")
                && !after.contains('?')
                && !after.contains('!');
            let preceded_by_text = s[..idx].trim_end_matches(' ').ends_with(|c: char| c != '\n');
            if looks_like_sign_off && preceded_by_text {
                let before = s[..idx].trim_end().to_string();
                let name = after.trim_end().to_string();
                s = if name.is_empty() {
                    format!("{before}\n\n{token}")
                } else {
                    format!("{before}\n\n{token}\n{name}")
                };
                break;
            }
            search_from = idx + token.len();
        }
    }

    // 3. Sign-off already on its own line but followed by the name on the same line.
    for token in SIGN_OFFS {
        let pattern = format!("\n{token} ");
        if let Some(idx) = s.find(&pattern) {
            let after = &s[idx + pattern.len()..];
            if after.len() <= 40 && !after.contains('\n') && !after.contains(". ") {
                s = format!("{}\n\n{}\n{}", s[..idx].trim_end(), token, after.trim());
            }
        }
    }

    // 4. Sign-off followed by a blank line and then just the name: tighten to one newline.
    for token in SIGN_OFFS {
        let pattern = format!("{token}\n\n");
        if let Some(idx) = s.rfind(&pattern) {
            let after = s[idx + pattern.len()..].trim();
            if !after.is_empty() && after.len() <= 40 && !after.contains('\n') && !after.contains(". ") {
                s = format!("{}{}\n{}", &s[..idx], token, after);
            }
        }
    }

    while s.contains("\n\n\n") {
        s = s.replace("\n\n\n", "\n\n");
    }
    s
}

fn map_result(email_id: i64, raw: RawTriageOutput) -> TriageResult {
    let (draft_reply, next_step_warning) = match raw.action {
        RawAction::DraftReply {
            draft_reply,
            verify_first,
        } => (Some(normalize_draft(&draft_reply)), verify_first),
        RawAction::Warning { warning, next_step } => {
            (None, Some(format!("{warning} Next step: {next_step}")))
        }
        RawAction::None {} => (None, None),
    };
    TriageResult {
        email_id,
        type_: type_str(&raw.type_).to_string(),
        priority: priority_str(&raw.priority).to_string(),
        summary: raw.summary,
        risk: risk_str(&raw.risk).to_string(),
        signals_json: serde_json::to_string(
            // The GBNF grammar cannot express set-uniqueness, so the model does sometimes
            // emit the same signal twice ("suspicious_links" showing up in one real run).
            // Deduplicate here, keeping first-mentioned order, so the UI never shows a
            // doubled badge.
            &dedupe_signals(&raw.signals),
        )
        .unwrap_or_else(|_| "[]".to_string()),
        risk_explanation: raw.risk_explanation,
        draft_reply,
        next_step_warning,
        triage_status: "ok".to_string(),
        model_version: MODEL_VERSION.to_string(),
        user_risk: None,
        done: false,
    }
}

/// Signal names in first-mentioned order, with repeats removed.
fn dedupe_signals(signals: &[RawSignal]) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::with_capacity(signals.len());
    for s in signals {
        let name = signal_str(s);
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

fn parse_error_result(email_id: i64) -> TriageResult {
    TriageResult {
        email_id,
        type_: "unknown".to_string(),
        priority: "medium".to_string(),
        summary: "Could not analyze this email automatically.".to_string(),
        risk: "caution".to_string(), // fail safe: never silently report "safe" on a parse failure
        signals_json: "[]".to_string(),
        risk_explanation:
            "The local model's output could not be parsed. Try triaging this email again."
                .to_string(),
        draft_reply: None,
        next_step_warning: None,
        triage_status: "parse_error".to_string(),
        model_version: MODEL_VERSION.to_string(),
        user_risk: None,
        done: false,
    }
}

fn persist(db: &Mutex<Connection>, r: &TriageResult) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO triage_results
            (email_id, type, priority, summary, risk, signals_json, risk_explanation,
             draft_reply, next_step_warning, triage_status, model_version, triaged_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))
         ON CONFLICT(email_id) DO UPDATE SET
            type=excluded.type, priority=excluded.priority, summary=excluded.summary,
            risk=excluded.risk, signals_json=excluded.signals_json,
            risk_explanation=excluded.risk_explanation, draft_reply=excluded.draft_reply,
            next_step_warning=excluded.next_step_warning, triage_status=excluded.triage_status,
            model_version=excluded.model_version, triaged_at=datetime('now')",
        params![
            r.email_id,
            r.type_,
            r.priority,
            r.summary,
            r.risk,
            r.signals_json,
            r.risk_explanation,
            r.draft_reply,
            r.next_step_warning,
            r.triage_status,
            r.model_version,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn type_str(t: &RawType) -> &'static str {
    match t {
        RawType::ActionNeeded => "action_needed",
        RawType::Fyi => "fyi",
        RawType::ScamRisk => "scam_risk",
        RawType::Personal => "personal",
        RawType::NewsletterPromo => "newsletter_promo",
    }
}

fn priority_str(p: &RawPriority) -> &'static str {
    match p {
        RawPriority::High => "high",
        RawPriority::Medium => "medium",
        RawPriority::Low => "low",
    }
}

fn risk_str(r: &RawRisk) -> &'static str {
    match r {
        RawRisk::Safe => "safe",
        RawRisk::Caution => "caution",
        RawRisk::Danger => "danger",
    }
}

fn signal_str(s: &RawSignal) -> &'static str {
    match s {
        RawSignal::UrgencyPressure => "urgency_pressure",
        RawSignal::MoneyRequest => "money_request",
        RawSignal::CredentialRequest => "credential_request",
        RawSignal::SenderMismatch => "sender_mismatch",
        RawSignal::SuspiciousLinks => "suspicious_links",
        RawSignal::EmotionalManipulation => "emotional_manipulation",
        RawSignal::SecrecyRequest => "secrecy_request",
        RawSignal::InconsistentFormatting => "inconsistent_formatting",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_danger_warning_output() {
        let json = r#"{
            "type": "scam_risk",
            "priority": "high",
            "summary": "Fake bank alert asking you to log in via a link.",
            "risk": "danger",
            "signals": ["urgency_pressure", "sender_mismatch", "suspicious_links"],
            "risk_explanation": "This claims to be your bank but the link goes to a different domain.",
            "action": {
                "kind": "warning",
                "warning": "This is very likely a phishing attempt.",
                "next_step": "Don't click the link; contact your bank using the number on your card."
            }
        }"#;
        let raw: RawTriageOutput = serde_json::from_str(json).unwrap();
        let result = map_result(1, raw);
        assert_eq!(result.risk, "danger");
        assert_eq!(result.draft_reply, None);
        assert!(result.next_step_warning.unwrap().contains("Don't click the link"));
        assert_eq!(result.triage_status, "ok");
    }

    #[test]
    fn parses_safe_draft_output() {
        let json = r#"{
            "type": "action_needed",
            "priority": "medium",
            "summary": "Coworker asks to reschedule tomorrow's meeting.",
            "risk": "safe",
            "signals": [],
            "risk_explanation": "No red flags - a normal work request.",
            "action": {
                "kind": "draft_reply",
                "draft_reply": "Sure, does 3pm work instead?",
                "verify_first": null
            }
        }"#;
        let raw: RawTriageOutput = serde_json::from_str(json).unwrap();
        let result = map_result(2, raw);
        assert_eq!(result.risk, "safe");
        assert_eq!(result.draft_reply.as_deref(), Some("Sure, does 3pm work instead?"));
        assert_eq!(result.next_step_warning, None);
    }

    #[test]
    fn parses_none_action_output() {
        let json = r#"{
            "type": "newsletter_promo",
            "priority": "low",
            "summary": "Weekly newsletter roundup.",
            "risk": "safe",
            "signals": [],
            "risk_explanation": "Routine newsletter, no concerns.",
            "action": { "kind": "none" }
        }"#;
        let raw: RawTriageOutput = serde_json::from_str(json).unwrap();
        let result = map_result(3, raw);
        assert_eq!(result.draft_reply, None);
        assert_eq!(result.next_step_warning, None);
    }

    #[test]
    fn label_grammar_lists_each_name_as_an_alternative() {
        let g = label_grammar(&["Finance".to_string(), "Say \"hi\"".to_string()]);
        assert!(g.contains(r#"label ::= "\"Finance\"" | "\"Say \\\"hi\\\"\"""#), "{g}");
        assert!(g.starts_with(r#"root ::= "{" ws "\"labels\":""#), "{g}");
    }

    #[test]
    fn content_hash_is_stable_and_distinguishes_inputs() {
        assert_eq!(content_hash("a", "b"), content_hash("a", "b"));
        assert_ne!(content_hash("a", "b"), content_hash("a", "c"));
        assert_ne!(content_hash("ab", ""), content_hash("a", "b"));
        assert_eq!(content_hash("a", "b").len(), 16);
    }

    #[test]
    fn normalize_draft_splits_greeting_and_sign_off() {
        let d = "Hi Cheng Guan, thanks for letting us know. We've noted your confirmation. Best regards, Jeya";
        assert_eq!(
            normalize_draft(d),
            "Hi Cheng Guan,\n\nthanks for letting us know. We've noted your confirmation.\n\nBest regards,\nJeya"
        );
    }

    #[test]
    fn normalize_draft_leaves_well_formed_drafts_alone() {
        let d = "Hi Dana,\n\nThanks for the heads-up. Could you confirm by phone?\n\nBest,\nJordan";
        assert_eq!(normalize_draft(d), d);
    }

    #[test]
    fn normalize_draft_does_not_mistake_mid_sentence_thanks_for_sign_off() {
        let d = "Hi Sam,\n\nThanks, I'll do that tomorrow and send it over. Best regards, Jeya";
        assert_eq!(
            normalize_draft(d),
            "Hi Sam,\n\nThanks, I'll do that tomorrow and send it over.\n\nBest regards,\nJeya"
        );
    }

    #[test]
    fn normalize_draft_tightens_blank_line_between_sign_off_and_name() {
        let d = "Hi ZhengHao,\n\nThanks for reaching out.\n\nBest regards,\n\nJeya";
        assert_eq!(normalize_draft(d), "Hi ZhengHao,\n\nThanks for reaching out.\n\nBest regards,\nJeya");
    }

    #[test]
    fn normalize_draft_moves_name_after_sign_off_to_own_line() {
        let d = "Hi Priya,\n\nThu 14:00 works.\nBest regards, Jeya";
        assert_eq!(normalize_draft(d), "Hi Priya,\n\nThu 14:00 works.\n\nBest regards,\nJeya");
    }

    #[test]
    fn duplicate_signals_are_collapsed_preserving_order() {
        // Taken from a real Gemma 4 run: the grammar permits repeats, so the model emitted
        // "suspicious_links" twice and the UI would have drawn the badge twice.
        let json = r#"{"type":"scam_risk","priority":"high","summary":"s","risk":"danger",
            "signals":["urgency_pressure","suspicious_links","credential_request","suspicious_links"],
            "risk_explanation":"e","action":{"kind":"warning","warning":"w","next_step":"n"}}"#;
        let raw: RawTriageOutput = serde_json::from_str(json).unwrap();
        let result = map_result(1, raw);
        assert_eq!(
            result.signals_json,
            r#"["urgency_pressure","suspicious_links","credential_request"]"#
        );
    }

    #[test]
    fn malformed_json_falls_back_to_parse_error_never_claims_safe() {
        let malformed = "not valid json at all";
        let outcome = serde_json::from_str::<RawTriageOutput>(malformed);
        assert!(outcome.is_err());
        let result = parse_error_result(4);
        assert_eq!(result.triage_status, "parse_error");
        assert_ne!(result.risk, "safe");
    }

    #[test]
    fn unknown_enum_value_fails_to_parse() {
        let json = r#"{
            "type": "not_a_real_type",
            "priority": "high",
            "summary": "x",
            "risk": "safe",
            "signals": [],
            "risk_explanation": "x",
            "action": { "kind": "none" }
        }"#;
        assert!(serde_json::from_str::<RawTriageOutput>(json).is_err());
    }
}
