/// Gemma's chat-template turn markers.
///
/// **Gemma 4 changed these.** Its `tokenizer.json` contains no `<start_of_turn>` token at all;
/// the canonical template (shipped as `chat_template.jinja` with the model) uses
/// `<|turn>role\n` ... `<turn|>\n`. Writing the old Gemma 2/3 markers here does not fail
/// loudly - they simply tokenize as ordinary text instead of control tokens, quietly degrading
/// every prompt in the app.
///
/// If you point the app at a Gemma 2/3 GGUF instead, change these back to
/// `<start_of_turn>` / `<end_of_turn>` - and verify against that model's own
/// `chat_template.jinja` rather than trusting documentation.
const TURN_START: &str = "<|turn>";
const TURN_END: &str = "<turn|>";

pub struct PromptInput<'a> {
    pub sender: &'a str,
    /// Raw "To" / "Cc" header values ("" when not recorded).
    pub to: &'a str,
    pub cc: &'a str,
    pub subject: &'a str,
    pub body_text: &'a str,
    pub user_email: &'a str,
}

/// Upper bound on body characters sent to the model *after* quoted history has been
/// stripped. Together with the instructions this stays comfortably inside the 4096-token
/// context even for token-dense text (URLs, signatures); the worker also hard-checks the
/// token count before decoding.
const MAX_BODY_CHARS: usize = 3000;

const INSTRUCTIONS: &str = r#"You are a private, fully on-device email triage assistant. Nothing you read or write ever leaves this device.

STEP 1 - CLASSIFY the email:
- type: one of action_needed, fyi, scam_risk, personal, newsletter_promo
- priority: high, medium, or low
- summary: one headline-style line, under 14 words, in direct active voice, stating what the
  email is about or what it needs - like a good inbox snippet, not a report about the sender.
  Good: "Room SR11 unavailable for 26 Aug; check booking details", "Invoice 4471 needs payment
  to a new bank account", "Thanks for the talk; invited back as Hack&Roll judge".
  Avoid: "The sender is informing...", "ZhengHao is thanking James for..."

STEP 2 - SCAM/FRAUD CHECK (always, every email). Set risk to safe, caution, or danger.
Check these 8 signals and list which ones fired: urgency/pressure language; requests for
money, gift cards, wire transfer, or crypto; requests for passwords, one-time codes, bank
details, or remote access; sender mismatch (display name vs actual domain, lookalike
domains); unexpected or obfuscated links/attachments; emotional manipulation (family
emergency, prize, government/authority impersonation); requests to keep this secret;
inconsistent grammar/formatting versus the claimed sender identity.
Give a 1-2 sentence, jargon-free explanation.

STEP 3 - ACTION:
- If risk is danger: no draft reply. Give a clear warning and one concrete next step
  (e.g. "don't click this link; contact the company using a number you already trust").
- If risk is caution: draft a reply that avoids confirming any personal or financial
  info, and note what to verify first before sending.
- If risk is safe and type is action_needed: draft a natural, concise reply in the
  user's own voice, matching the thread's tone and formality.
- If risk is safe and type is fyi or newsletter_promo: no draft needed.

WHO IS BEING ADDRESSED: the To/Cc headers show who the message was sent to. The user is
the person whose address is given below. If the user is only CC'd, or is not in To/Cc at
all (mailing list, group alias, forward), then other people are expected to respond: classify
it as fyi for the user (not action_needed) and use action kind "none" - unless the body
explicitly asks the user, by name or address, to do something. Only draft a reply when the
user is the one expected to answer, and only ever write it from the user's point of view.

THREAD HISTORY: only the newest message is shown; earlier quoted messages were removed.
Judge the newest message, and do not treat requests made to other people in the past as
requests to the user now.

DRAFT FORMAT: when you write draft_reply, lay it out like a real email, using \n for line
breaks: a greeting line, a blank line, one to three short paragraphs separated by blank
lines, a blank line, a sign-off line (e.g. "Best regards,"), then the user's first name on
its own line (infer it from their email address if it isn't stated).

Respond with ONLY a single JSON object matching the required schema. No prose before or after."#;

/// Builds the full prompt, wrapped in Gemma's chat template (see `TURN_START`/`TURN_END`).
/// The markers tokenize as real control tokens rather than literal text - llama-cpp-2's
/// `str_to_token` always parses special tokens.
pub fn build_triage_prompt(input: &PromptInput) -> String {
    let (newest, stripped) = strip_quoted_history(input.body_text);
    let body = truncate_chars(&newest, MAX_BODY_CHARS);
    let addressing = describe_addressing(input.user_email, input.to, input.cc);
    let to = if input.to.trim().is_empty() { "(not recorded)" } else { input.to.trim() };
    let cc = if input.cc.trim().is_empty() { "(none)" } else { input.cc.trim() };
    let history_note = if stripped {
        " - earlier quoted messages in this thread were omitted"
    } else {
        ""
    };
    format!(
        "{TURN_START}user\n{INSTRUCTIONS}\n\n\
         The user's own email address is: {}\n\
         Addressing: {}\n\
         From: {}\nTo: {}\nCc: {}\nSubject: {}\n\n\
         Body (newest message only{}):\n{}\n{TURN_END}\n{TURN_START}model\n",
        input.user_email, addressing, input.sender, to, cc, input.subject, history_note, body
    )
}

/// Plain-language statement of how the user relates to the recipients, for the prompt.
pub fn describe_addressing(user_email: &str, to: &str, cc: &str) -> &'static str {
    let user = user_email.trim().to_ascii_lowercase();
    if user.is_empty() {
        return "recipients unknown";
    }
    let in_to = to.to_ascii_lowercase().contains(&user);
    let in_cc = cc.to_ascii_lowercase().contains(&user);
    if in_to {
        "the user is directly addressed (listed in To)"
    } else if in_cc {
        "the user is only CC'd - the people in To are the primary recipients"
    } else if to.trim().is_empty() && cc.trim().is_empty() {
        "recipients not recorded - treat as possibly not addressed to the user"
    } else {
        "the user is not in To or Cc (mailing list, group alias, or forward) - treat as not addressed to the user"
    }
}

/// Returns the newest message in a reply chain - everything above the first quoted block -
/// and whether anything was stripped. Recognizes Gmail/Apple Mail ("On ... wrote:", possibly
/// wrapped onto a second line), Outlook ("-----Original Message-----" / "From: ... Sent: ...")
/// and ">"-prefixed quotes. If stripping would leave nothing (a bare forward), the original
/// body is returned unchanged.
pub fn strip_quoted_history(body: &str) -> (String, bool) {
    let lines: Vec<&str> = body.lines().collect();
    let mut cut: Option<usize> = None;

    for (i, raw) in lines.iter().enumerate() {
        let t = raw.trim();
        if t.starts_with('>') {
            cut = Some(i);
            break;
        }
        // Forwarded content is the message itself - skip the forward divider but keep
        // scanning: reply history *below* the forwarded message is still stripped.
        let lower = t.to_ascii_lowercase();
        if (lower.starts_with("---") && lower.contains("forwarded message")) || lower.starts_with("begin forwarded message") {
            continue;
        }
        if t.starts_with("-----Original Message") {
            cut = Some(i);
            break;
        }
        let looks_like_on_wrote = (t.starts_with("On ") || t.starts_with("Le ") || t.starts_with("Am "))
            && (t.contains(',') || t.contains(" at ") || t.contains(" um "))
            && (t.ends_with("wrote:")
                || t.ends_with("écrit :")
                || t.ends_with("schrieb:")
                || lines[i + 1..(i + 3).min(lines.len())]
                    .iter()
                    .any(|l| l.trim().ends_with("wrote:")));
        if looks_like_on_wrote {
            cut = Some(i);
            break;
        }
        let from_line = t.starts_with("From:") || t.starts_with("*From:*");
        if from_line
            && lines[i + 1..(i + 6).min(lines.len())].iter().any(|l| {
                let l = l.trim().trim_start_matches('*');
                l.starts_with("Sent:") || l.starts_with("To:") || l.starts_with("Subject:") || l.starts_with("Date:")
            })
        {
            // Outlook header block: a reply quote only if its Subject is a RE:; otherwise it is
            // a forward and the content below is the message.
            let subject_line = lines[i + 1..(i + 8).min(lines.len())]
                .iter()
                .map(|l| l.trim().trim_start_matches('*'))
                .find(|l| l.to_ascii_lowercase().starts_with("subject:"));
            let is_reply = subject_line
                .map(|l| {
                    let rest = l[8..].trim_start_matches('*').trim().to_ascii_lowercase();
                    rest.starts_with("re:") || rest.starts_with("re :") || rest.starts_with("aw:") || rest.starts_with("sv:")
                })
                .unwrap_or(false);
            if !is_reply {
                continue; // forward header: keep it and the forwarded body, keep scanning
            }
            cut = Some(i);
            break;
        }
    }

    let Some(i) = cut else {
        return (body.to_string(), false);
    };
    let mut head = lines[..i].join("\n");
    // Drop a trailing signature separator left dangling above the quote.
    let trimmed = head.trim_end();
    if trimmed.ends_with("--") || trimmed.ends_with("-- ") {
        head = trimmed.trim_end_matches('-').trim_end().to_string();
    }
    let head = head.trim_end().to_string();
    if head.trim().is_empty() {
        return (body.to_string(), false);
    }
    (head, true)
}

const REPLY_INSTRUCTIONS: &str = r#"You are a private, fully on-device writing assistant inside an email client. Nothing you read or write leaves this device.

Write a reply to the email below on behalf of the user, in the user's own voice, matching the thread's tone and formality. Be natural and concise: under 120 words unless the email is long-form and warrants more. Never invent facts that are not in the email. Never include personal, financial, or credential details. If the email was not addressed to the user, write as someone who was copied in and is choosing to respond.

Lay it out like a real email, using \n for line breaks: a greeting line, a blank line, one to three short paragraphs separated by blank lines, a blank line, a sign-off line (e.g. "Best regards,"), then the user's first name on its own line (infer it from their email address if it isn't stated).

Respond with ONLY a JSON object of the form {"draft_reply": "..."}. No prose before or after."#;

/// Best-effort first name from an address like "jeya.s@x.org" -> "Jeya", for sign-offs.
pub fn first_name_from_email(email: &str) -> String {
    let local = email.split('@').next().unwrap_or("");
    let first = local.split(['.', '_', '-', '+']).next().unwrap_or(local);
    let mut chars = first.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Prompt for an on-demand reply draft (used when the user asks to reply to an email that
/// triage did not draft for, e.g. one they were only CC'd on).
pub fn build_reply_prompt(input: &PromptInput) -> String {
    build_reply_prompt_with(input, None, None)
}

/// Reply prompt with optional user guidance ("decline politely", "shorter") and, when the
/// user is revising, the current draft to rewrite rather than starting over.
pub fn build_reply_prompt_with(
    input: &PromptInput,
    instructions: Option<&str>,
    previous_draft: Option<&str>,
) -> String {
    let (newest, stripped) = strip_quoted_history(input.body_text);
    let body = truncate_chars(&newest, MAX_BODY_CHARS);
    let addressing = describe_addressing(input.user_email, input.to, input.cc);
    let to = if input.to.trim().is_empty() { "(not recorded)" } else { input.to.trim() };
    let cc = if input.cc.trim().is_empty() { "(none)" } else { input.cc.trim() };
    let history_note = if stripped { " - earlier quoted messages omitted" } else { "" };
    let name = first_name_from_email(input.user_email);
    let persona = format!(
        "You are writing AS the user, {name} <{}>, in the first person. Sign off as {name}. \
         Never write as, or sign as, the person the email was addressed to or the person who sent it.",
        input.user_email
    );
    let guidance = match instructions.map(str::trim).filter(|s| !s.is_empty()) {
        Some(i) => format!("\n\nThe user's instructions for this reply (follow them closely): {i}"),
        None => String::new(),
    };
    let revision = match previous_draft.map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => format!(
            "\n\nCurrent draft - rewrite it according to the instructions, keeping what still fits:\n---\n{}\n---",
            truncate_chars(d, 2000)
        ),
        None => String::new(),
    };
    format!(
        "{TURN_START}user\n{REPLY_INSTRUCTIONS}\n\n{persona}{guidance}\n\n\
         The user's own email address is: {}\n\
         Addressing: {}\n\
         From: {}\nTo: {}\nCc: {}\nSubject: {}\n\n\
         Body (newest message only{}):\n{}{revision}\n{TURN_END}\n{TURN_START}model\n",
        input.user_email, addressing, input.sender, to, cc, input.subject, history_note, body
    )
}

const SUMMARY_INSTRUCTIONS: &str = r#"You are a private, fully on-device assistant inside an email client. Summarize the email message below as ONE headline-style line of at most 14 words, in direct active voice, stating what it says or asks - like a good inbox snippet (e.g. "Venue confirmed: COM3 SR12, arrive 6:50 PM Friday", "Bio and photo needed by 17 Aug for publicity"). Do not invent facts. Do not start with "The sender" or the sender's name.

Respond with ONLY a JSON object of the form {"summary": "..."}."#;

/// Prompt for a one-line summary of a single (usually quoted/earlier) message.
pub fn build_summary_prompt(sender: &str, text: &str) -> String {
    let body = truncate_chars(text, 2500);
    format!(
        "{TURN_START}user\n{SUMMARY_INSTRUCTIONS}\n\nFrom: {}\n\nMessage:\n{}\n{TURN_END}\n{TURN_START}model\n",
        sender, body
    )
}

const LABEL_INSTRUCTIONS: &str = r#"You are a private, fully on-device assistant inside an email client. The user has described what each of their Gmail labels is for. Decide which of those labels apply to the email below by judging what the email is actually about (its subject and body) against each description. Apply a label only when the email's main topic is the thing the description covers; several labels may apply. Do NOT apply a label merely because the sender, organisation, or a keyword is related to it: a label about one specific event or series does not cover other events, recruitment drives, or general mail from the same group. If no description clearly fits, return an empty list - that is a normal, expected answer.

Respond with ONLY a JSON object of the form {"labels": ["Label name", ...]} (an empty array if none apply)."#;

/// Prompt asking which of the user's described labels fit an email.
pub fn build_label_prompt(labels: &[(String, String)], input: &PromptInput) -> String {
    let (newest, _) = strip_quoted_history(input.body_text);
    let body = truncate_chars(&newest, 2500);
    let mut list = String::new();
    for (name, description) in labels {
        list.push_str(&format!("- {name}: {description}\n"));
    }
    format!(
        "{TURN_START}user\n{LABEL_INSTRUCTIONS}\n\nThe user's labels:\n{list}\n\
         From: {}\nTo: {}\nSubject: {}\n\nBody:\n{}\n{TURN_END}\n{TURN_START}model\n",
        input.sender, input.to, input.subject, body
    )
}

/// One stored message in a thread, oldest-first, as the meeting scanner sees it.
pub struct ThreadMessage<'a> {
    pub sender: &'a str,
    /// True when this message was sent by the user (from their Sent folder).
    pub from_user: bool,
    /// The message's own date, so the model can resolve "Thursday 3pm" correctly.
    pub received_at: &'a str,
    pub body_text: &'a str,
}

/// Only the tail of a thread is scanned: a meeting is agreed in the last few messages, and
/// the whole prompt must fit the worker's 4096-token context or generation is refused outright.
const MEETING_MAX_MESSAGES: usize = 6;
const MEETING_MAX_CHARS_PER_MESSAGE: usize = 1200;

const MEETING_INSTRUCTIONS: &str = r#"You are a private, fully on-device assistant inside an email client. Nothing you read leaves this device. Read the email thread below and decide whether it arranges a meeting or call involving the user.

Set kind to exactly one of:
- "confirmed": the thread contains a real joinable meeting link (Google Meet, Zoom, Teams, Webex, Whereby) AND a time.
- "possible": no link, but the user AND the other person have BOTH agreed on a time. One side proposing a time is NOT enough - look for the other side accepting it.
- "none": no meeting, or only a vague intention ("let's catch up sometime", "I'll send times later").

Set has_meeting to false when kind is "none".

title: a short phrase describing what the meeting is about, drawn from the whole thread's subject matter. Not the sender's name, not "Meeting".

starts_at: the meeting's start as YYYY-MM-DDTHH:MM, in 24-hour time. Resolve relative dates ("Thursday", "tomorrow") against the date of the message that stated them, which is given for each message below. If you cannot determine a specific date and time, set kind to "none".

duration_minutes: the stated duration, or 30 if not stated.

join_url: the meeting link exactly as it appears in the thread, copied character for character. If several appear, use the one from the most recent message. Use null when there is no link.

confidence: "high" only when both the time and the agreement are explicit.

Respond with ONLY a single JSON object matching the required schema."#;

/// Builds the thread-level meeting-extraction prompt.
///
/// This is deliberately thread-level, not message-level: "both sides agreed" is not visible
/// in any single message. Each stored message still has its own quoted copy of the earlier
/// ones stripped - those appear as their own entries here, so keeping them would repeat the
/// thread N times and blow the context budget. What this adds over `build_triage_prompt` is
/// the real back-and-forth across messages, with the user's own replies marked.
pub fn build_meeting_prompt(thread: &[ThreadMessage], user_email: &str, today: &str) -> String {
    let start = thread.len().saturating_sub(MEETING_MAX_MESSAGES);
    let mut transcript = String::new();
    for m in &thread[start..] {
        let who = if m.from_user {
            "FROM THE USER".to_string()
        } else {
            format!("FROM {}", m.sender)
        };
        let (newest, _) = strip_quoted_history(m.body_text);
        transcript.push_str(&format!(
            "--- {} | sent {} ---\n{}\n\n",
            who,
            m.received_at,
            truncate_chars(&newest, MEETING_MAX_CHARS_PER_MESSAGE)
        ));
    }
    format!(
        "{TURN_START}user\n{MEETING_INSTRUCTIONS}\n\n\
         The user's own email address is: {}\n\
         Today's date is: {}\n\n\
         Thread (oldest first):\n{}{TURN_END}\n{TURN_START}model\n",
        user_email, today, transcript
    )
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(body: &'a str, to: &'a str, cc: &'a str) -> PromptInput<'a> {
        PromptInput {
            sender: "Alice <alice@example.com>",
            to,
            cc,
            subject: "Lunch tomorrow?",
            body_text: body,
            user_email: "bob@example.com",
        }
    }

    #[test]
    fn includes_email_fields() {
        let prompt = build_triage_prompt(&input("Are you free at noon?", "bob@example.com", ""));
        assert!(prompt.contains("Alice <alice@example.com>"));
        assert!(prompt.contains("Lunch tomorrow?"));
        assert!(prompt.contains("Are you free at noon?"));
        assert!(prompt.contains("bob@example.com"));
        assert!(prompt.contains("directly addressed"));
        assert!(prompt.starts_with(&format!("{TURN_START}user\n")));
        assert!(prompt.ends_with(&format!("{TURN_START}model\n")));
    }

    #[test]
    fn truncates_long_bodies() {
        let long_body = "x".repeat(10_000);
        let prompt = build_triage_prompt(&input(&long_body, "bob@example.com", ""));
        assert!(prompt.len() < long_body.len());
    }

    #[test]
    fn addressing_distinguishes_to_cc_and_neither() {
        assert!(describe_addressing("bob@x.com", "Bob <bob@x.com>", "").contains("directly addressed"));
        assert!(describe_addressing("bob@x.com", "carol@x.com", "bob@x.com").contains("only CC'd"));
        assert!(describe_addressing("bob@x.com", "list@x.com", "dave@x.com").contains("not in To or Cc"));
        assert!(describe_addressing("bob@x.com", "", "").contains("not recorded"));
        // case-insensitive
        assert!(describe_addressing("Bob@X.com", "bob@x.com", "").contains("directly addressed"));
    }

    #[test]
    fn strips_gmail_style_quote() {
        let body = "Hey James!\n\nThanks for the talk.\n\nBest,\nZH\n\nOn Thu, Aug 20, 2026 at 1:07 PM ZhengHao Fang <zh@x.org>\nwrote:\n\n> Hi James,\n> older stuff";
        let (newest, stripped) = strip_quoted_history(body);
        assert!(stripped);
        assert_eq!(newest, "Hey James!\n\nThanks for the talk.\n\nBest,\nZH");
    }

    #[test]
    fn strips_single_line_on_wrote_and_bare_quotes() {
        let (n, s) = strip_quoted_history("Sure.\n\nOn Mon, 3 Dec 2025, at 8:11 PM, Greg <g@x.com> wrote:\n> hi");
        assert!(s);
        assert_eq!(n, "Sure.");
        let (n, s) = strip_quoted_history("Top line\n> quoted\n> more");
        assert!(s);
        assert_eq!(n, "Top line");
    }

    #[test]
    fn strips_outlook_header_block() {
        let body = "Thanks, received.\n\nFrom: Greg Thom <greg@x.com>\nSent: Friday, 30 January 2026 7:21 AM\nTo: Ravern\nSubject: Re: planning\n\nHey Ravern";
        let (n, s) = strip_quoted_history(body);
        assert!(s);
        assert_eq!(n, "Thanks, received.");
    }

    #[test]
    fn keeps_forwarded_content_as_the_message() {
        let gmail_fwd = "FYI\n\n---------- Forwarded message ---------\nFrom: Jerina <booking@x.edu>\nDate: Fri\nSubject: Booking\n\nSR11 is not available.";
        let (n, s) = strip_quoted_history(gmail_fwd);
        assert!(!s);
        assert_eq!(n, gmail_fwd);
        let outlook_fwd = "Forwarding for visibility\n\nFrom: Jerina via SoC RT <booking@x.edu>\nSent: Friday\nTo: Hou Man\nSubject: [SOC #1] Booking\n\nSR11 is not available.";
        let (n, s) = strip_quoted_history(outlook_fwd);
        assert!(!s);
        assert_eq!(n, outlook_fwd);
        // Forward followed by the reply chain underneath: keep the forwarded message, trim the chain.
        let fwd_with_chain = "FYI\n\nFrom: Jerina <booking@x.edu>\nSent: Friday\nTo: Hou Man\nSubject: [SOC #1] Booking\n\nSR11 is not available.\n\nBest Regards,\nHou Man\n\nFrom: Wai Hou Man <h@x.edu>\nSent: Tuesday\nTo: booking@x.edu\nSubject: Re: [SOC #1] Booking\n\nHey Jerina, thanks for assisting.";
        let (n, s) = strip_quoted_history(fwd_with_chain);
        assert!(s);
        assert!(n.contains("SR11 is not available."));
        assert!(n.ends_with("Hou Man"));
        assert!(!n.contains("Hey Jerina"));
        // ...but an Outlook RE: block is still history.
        let outlook_reply = "Thanks!\n\nFrom: Greg <g@x.com>\nSent: Monday\nTo: Me\nSubject: RE: planning\n\nold text";
        let (n, s) = strip_quoted_history(outlook_reply);
        assert!(s);
        assert_eq!(n, "Thanks!");
    }

    #[test]
    fn leaves_plain_emails_alone() {
        let body = "On Friday we will meet at noon.\nBring the slides.";
        let (n, s) = strip_quoted_history(body);
        assert!(!s);
        assert_eq!(n, body);
    }

    #[test]
    fn keeps_original_when_nothing_but_quote_remains() {
        let body = "> forwarded line 1\n> forwarded line 2";
        let (n, s) = strip_quoted_history(body);
        assert!(!s);
        assert_eq!(n, body);
    }

    fn tm<'a>(sender: &'a str, from_user: bool, at: &'a str, body: &'a str) -> ThreadMessage<'a> {
        ThreadMessage { sender, from_user, received_at: at, body_text: body }
    }

    #[test]
    fn meeting_prompt_marks_the_users_own_messages() {
        let thread = vec![
            tm("Alice <alice@x.com>", false, "2026-08-20", "Can we do Thursday 3pm?"),
            tm("bob@example.com", true, "2026-08-20", "Thursday 3pm works for me."),
        ];
        let p = build_meeting_prompt(&thread, "bob@example.com", "2026-08-22");
        assert!(p.contains("FROM THE USER"));
        assert!(p.contains("FROM Alice <alice@x.com>"));
        // Both sides must be visible - that is the whole point of scanning at thread level.
        assert!(p.contains("Can we do Thursday 3pm?"));
        assert!(p.contains("Thursday 3pm works for me."));
        assert!(p.starts_with(&format!("{TURN_START}user\n")));
        assert!(p.ends_with(&format!("{TURN_START}model\n")));
    }

    #[test]
    fn meeting_prompt_anchors_relative_dates() {
        let thread = vec![tm("a@x.com", false, "2026-08-20", "Thursday works")];
        let p = build_meeting_prompt(&thread, "bob@example.com", "2026-08-22");
        // Both today's date and each message's own date must be present, or "Thursday"
        // cannot be resolved to a real calendar day.
        assert!(p.contains("Today's date is: 2026-08-22"));
        assert!(p.contains("sent 2026-08-20"));
    }

    #[test]
    fn meeting_prompt_keeps_only_the_most_recent_messages() {
        let bodies: Vec<String> = (0..10).map(|i| format!("message number {i}")).collect();
        let thread: Vec<ThreadMessage> = bodies
            .iter()
            .map(|b| tm("a@x.com", false, "2026-08-20", b))
            .collect();
        let p = build_meeting_prompt(&thread, "bob@example.com", "2026-08-22");
        // Oldest dropped, newest kept - a long thread must not blow the 4096-token context.
        assert!(!p.contains("message number 0"));
        assert!(!p.contains("message number 3"));
        assert!(p.contains("message number 9"));
    }

    #[test]
    fn meeting_prompt_strips_each_messages_quoted_copy() {
        // Each stored message quotes the previous one; those appear as their own entries,
        // so leaving the quotes in would repeat the thread and waste the context budget.
        let thread = vec![
            tm("a@x.com", false, "2026-08-20", "Original ask"),
            tm("b@x.com", true, "2026-08-21", "Sure!\n\n> Original ask"),
        ];
        let p = build_meeting_prompt(&thread, "bob@example.com", "2026-08-22");
        assert!(p.contains("Sure!"));
        assert!(!p.contains("> Original ask"));
    }

    #[test]
    fn first_name_from_email_capitalizes_local_part() {
        assert_eq!(first_name_from_email("jeya@nushackers.org"), "Jeya");
        assert_eq!(first_name_from_email("zheng.hao@x.org"), "Zheng");
        assert_eq!(first_name_from_email("@x.org"), "");
    }

    #[test]
    fn reply_prompt_carries_persona_instructions_and_previous_draft() {
        let prompt = build_reply_prompt_with(&input("Can you judge again?", "x@x.com", "bob@example.com"), Some("decline politely"), Some("Hi, sure!"));
        assert!(prompt.contains("writing AS the user, Bob <bob@example.com>"));
        assert!(prompt.contains("Sign off as Bob"));
        assert!(prompt.contains("instructions for this reply (follow them closely): decline politely"));
        assert!(prompt.contains("Current draft - rewrite it"));
        assert!(prompt.contains("Hi, sure!"));
    }

    #[test]
    fn reply_prompt_includes_email_and_asks_for_json_draft() {
        let prompt = build_reply_prompt(&input("Can you judge again?\n\n> old", "x@x.com", "bob@example.com"));
        assert!(prompt.contains("Can you judge again?"));
        assert!(!prompt.contains("> old"));
        assert!(prompt.contains("\"draft_reply\""));
        assert!(prompt.contains("only CC'd"));
        assert!(prompt.ends_with(&format!("{TURN_START}model\n")));
    }

    #[test]
    fn prompt_notes_when_history_was_omitted() {
        let prompt = build_triage_prompt(&input("New bit\n\n> old", "x@x.com", "bob@example.com"));
        assert!(prompt.contains("earlier quoted messages in this thread were omitted"));
        assert!(prompt.contains("only CC'd"));
        assert!(!prompt.contains("> old"));
    }
}
