//! Cheap keyword gate in front of the meeting scanner.
//!
//! Meeting extraction costs one on-device inference per thread - seconds to tens of seconds on
//! CPU. Most threads in a real inbox never mention a meeting at all, so scanning every one of
//! them turns "Scan mail" into an hours-long operation for no benefit.
//!
//! This gate is deliberately **broad and one-sided**: a false positive costs one wasted
//! inference, while a false negative silently loses a real meeting. So it errs heavily towards
//! letting threads through, and only skips text with no scheduling signal whatsoever.

/// Words that suggest a meeting is being arranged.
const MEETING_WORDS: &[&str] = &[
    "meet", "meeting", "call", "zoom", "teams", "webex", "whereby", "hangout", "huddle",
    "sync", "standup", "stand-up", "catch up", "catch-up", "coffee", "lunch", "dinner",
    "appointment", "schedule", "scheduling", "reschedule", "calendar", "invite", "availability",
    "available", "free at", "free on", "book", "booking", "slot", "session", "consult",
    "interview", "demo", "chat", "discuss", "presentation", "briefing", "1:1", "one-on-one",
];

/// Words that suggest a specific time is being named.
const TIME_WORDS: &[&str] = &[
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "today", "tomorrow", "tonight", "next week", "this week", "morning", "afternoon",
    "evening", "am", "pm", "a.m.", "p.m.", "o'clock", "noon", "midday",
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// True when the thread is worth spending an inference on.
///
/// Requires *either* an explicit meeting link (decisive on its own) *or* a meeting word paired
/// with something time-shaped. The pairing is what keeps the gate from passing every message
/// that happens to contain the word "call" or a weekday in a signature.
pub fn worth_scanning(thread_text: &str) -> bool {
    let text = thread_text.to_ascii_lowercase();

    // A meeting link settles it - no need for any other signal.
    if text.contains("meet.google.com")
        || text.contains("zoom.us/j/")
        || text.contains("teams.microsoft.com")
        || text.contains("webex.com")
        || text.contains("whereby.com")
    {
        return true;
    }

    let has_meeting_word = MEETING_WORDS.iter().any(|w| text.contains(w));
    if !has_meeting_word {
        return false;
    }

    // A digit-and-colon or digit-and-meridiem pattern covers "15:30" / "3pm" without needing a
    // real parser here.
    let has_clock_time = contains_clock_time(&text);
    let has_time_word = TIME_WORDS.iter().any(|w| text.contains(w));

    has_clock_time || has_time_word
}

/// Spots "15:30", "3pm", "3 pm", "9.30am" without pulling in a date parser.
fn contains_clock_time(text: &str) -> bool {
    let bytes = text.as_bytes();
    for (i, &c) in bytes.iter().enumerate() {
        if !c.is_ascii_digit() {
            continue;
        }
        let rest = &text[i..];
        // "3:30" / "15:30"
        if rest.len() > 2 {
            let after = &bytes[i + 1..];
            if after.first() == Some(&b':') || (after.first().is_some_and(u8::is_ascii_digit) && after.get(1) == Some(&b':')) {
                return true;
            }
        }
        // "3pm" / "3 pm"
        let tail = rest[1..].trim_start();
        if tail.starts_with("pm") || tail.starts_with("am") {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_a_thread_with_a_meeting_link() {
        assert!(worth_scanning("here you go https://meet.google.com/abc-defg-hij"));
    }

    #[test]
    fn passes_meeting_word_with_a_clock_time() {
        assert!(worth_scanning("Can we do a call at 15:30?"));
        assert!(worth_scanning("Lunch at 1pm works"));
    }

    #[test]
    fn passes_meeting_word_with_a_day_word() {
        assert!(worth_scanning("Shall we sync on Thursday?"));
    }

    #[test]
    fn skips_ordinary_mail_with_no_scheduling_signal() {
        assert!(!worth_scanning("Your invoice 4471 is attached. Payment terms are net 30."));
        assert!(!worth_scanning("Thanks for the update, looks good to me."));
    }

    #[test]
    fn skips_a_bare_weekday_with_no_meeting_word() {
        // A date in a signature or newsletter must not cost an inference.
        assert!(!worth_scanning("Sent on Tuesday. Unsubscribe at the link below."));
    }

    #[test]
    fn is_case_insensitive() {
        assert!(worth_scanning("MEETING on FRIDAY"));
    }

    #[test]
    fn errs_towards_scanning_when_signals_are_weak() {
        // Vague, but it does mention a meeting and a day - cheaper to scan than to miss.
        assert!(worth_scanning("coffee tomorrow?"));
    }
}
