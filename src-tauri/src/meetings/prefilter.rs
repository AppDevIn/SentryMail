//! Cheap keyword gate in front of the meeting scanner.
//!
//! Meeting extraction costs one on-device inference per thread - seconds to tens of seconds on
//! CPU. Most threads in a real inbox never mention a meeting at all, so scanning every one of
//! them turns "Scan mail" into an hours-long operation for no benefit.
//!
//! This gate is deliberately **broad and one-sided**: a false positive costs one wasted
//! inference, while a false negative silently loses a real meeting. So it errs heavily towards
//! letting threads through, and only skips text with no scheduling signal whatsoever.

/// Single words suggesting a meeting is being arranged. Matched on **word boundaries**, not as
/// substrings: a plain `contains` here made "am" match "team"/"name"/"exam" and "book" match
/// "facebook", which let 69% of a real 626-thread inbox through instead of 34%.
const MEETING_WORDS: &[&str] = &[
    "meet", "meeting", "meetings", "call", "calls", "zoom", "teams", "webex", "whereby",
    "huddle", "sync", "standup", "appointment", "schedule", "scheduled", "reschedule",
    "calendar", "availability", "slot", "consult", "interview",
    // Social meetings get arranged as often as formal ones. Safe as whole words - unlike
    // "book"/"am", none of these are substrings of common unrelated words.
    "lunch", "dinner", "coffee", "breakfast", "drinks", "brunch",
];

/// Multi-word phrases. These are distinctive enough to match as plain substrings.
const MEETING_PHRASES: &[&str] = &[
    "catch up", "catch-up", "stand-up", "one-on-one", "1:1", "are you free", "free at",
    "free on", "coffee chat", "set up a time", "book a time", "find a time",
];

/// Day-relative words, again word-boundary matched.
const DAY_WORDS: &[&str] = &[
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "today", "tomorrow", "tonight",
];

const DAY_PHRASES: &[&str] = &["next week", "this week"];

const MONTHS: &[&str] = &[
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// True when the thread is worth spending an inference on.
///
/// Requires either an explicit meeting link (decisive on its own), or a meeting word paired
/// with something time-shaped. The pairing keeps ordinary mail that merely says "call" or
/// names a weekday in a signature from costing an inference.
pub fn worth_scanning(thread_text: &str) -> bool {
    let text = thread_text.to_ascii_lowercase();

    if text.contains("meet.google.com")
        || text.contains("zoom.us/j/")
        || text.contains("teams.microsoft.com")
        || text.contains("webex.com")
        || text.contains("whereby.com")
    {
        return true;
    }

    let has_meeting = MEETING_WORDS.iter().any(|w| contains_word(&text, w))
        || MEETING_PHRASES.iter().any(|p| text.contains(p));
    if !has_meeting {
        return false;
    }

    contains_clock_time(&text)
        || DAY_WORDS.iter().any(|w| contains_word(&text, w))
        || DAY_PHRASES.iter().any(|p| text.contains(p))
        || contains_numeric_date(&text)
}

/// Substring match that additionally requires non-alphanumeric neighbours, so "call" does not
/// match "called" and "meet" does not match "meeting" (both spellings are listed explicitly).
fn contains_word(haystack: &str, needle: &str) -> bool {
    let mut from = 0usize;
    while let Some(rel) = haystack[from..].find(needle) {
        let start = from + rel;
        let end = start + needle.len();
        let before_ok = start == 0
            || !haystack[..start].chars().next_back().is_some_and(|c| c.is_alphanumeric());
        let after_ok = end == haystack.len()
            || !haystack[end..].chars().next().is_some_and(|c| c.is_alphanumeric());
        if before_ok && after_ok {
            return true;
        }
        from = end;
        if from >= haystack.len() {
            break;
        }
    }
    false
}

/// Spots "15:30", "3pm", "3 p.m." - a real clock time, not any digit.
fn contains_clock_time(text: &str) -> bool {
    let b = text.as_bytes();
    for i in 0..b.len() {
        if !b[i].is_ascii_digit() {
            continue;
        }
        // Only consider the start of a number.
        if i > 0 && b[i - 1].is_ascii_digit() {
            continue;
        }
        let mut j = i;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j - i > 2 {
            continue; // more than two digits is not an hour
        }
        let rest = &text[j..];
        // "3:30"
        if rest.starts_with(':') && rest.len() > 2 && rest[1..3].bytes().all(|c| c.is_ascii_digit()) {
            return true;
        }
        // "3pm" / "3 pm" / "3 p.m."
        let t = rest.trim_start();
        if t.starts_with("am") || t.starts_with("pm") || t.starts_with("a.m.") || t.starts_with("p.m.") {
            return true;
        }
    }
    false
}

/// Spots "12 Aug" / "Aug 12" - a month name sitting next to a number. A bare month name is far
/// too common in ordinary prose ("may", "mar") to count on its own.
fn contains_numeric_date(text: &str) -> bool {
    for m in MONTHS {
        let mut from = 0usize;
        while let Some(rel) = text[from..].find(m) {
            let start = from + rel;
            let before = text[..start].trim_end();
            if before.chars().next_back().is_some_and(|c| c.is_ascii_digit()) {
                return true;
            }
            // Skip the rest of the month word, then look for a following number.
            let mut end = start + m.len();
            while end < text.len() && text[end..].chars().next().is_some_and(|c| c.is_alphabetic()) {
                end += 1;
            }
            let after = text[end..].trim_start();
            if after.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                return true;
            }
            from = start + m.len();
            if from >= text.len() {
                break;
            }
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
    fn substrings_do_not_count_as_words() {
        // The real bug: these all passed the old `contains` filter.
        assert!(!worth_scanning("The team name is Example. Sent Tuesday."));
        assert!(!worth_scanning("Follow us on facebook, updates every Monday."));
        assert!(!worth_scanning("Your exam results are available Monday."));
    }

    #[test]
    fn bare_month_word_does_not_count_as_a_date() {
        assert!(!worth_scanning("You may schedule this at your convenience."));
        assert!(worth_scanning("Let's schedule the interview for 12 Aug"));
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
