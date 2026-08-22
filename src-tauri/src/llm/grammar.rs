/// GBNF grammar constraining the model's output to a single JSON object
/// matching the triage schema (see `crate::triage`). Using grammar-constrained
/// sampling instead of free-form prose is what makes a small on-device
/// model's output reliably parseable.
pub const TRIAGE_GBNF: &str = include_str!("triage_grammar.gbnf");
pub const TRIAGE_GRAMMAR_ROOT: &str = "root";

/// GBNF grammar for an on-demand reply draft: a single JSON object with one string field.
/// Same newline caveat as the triage grammar - rule bodies stay on one line.
pub const REPLY_GBNF: &str = r#"root ::= "{" ws "\"draft_reply\":" ws string ws "}"
ws ::= [ \t\n]*
char ::= [^"\\] | "\\" (["\\/bfnrt] | "u" hex hex hex hex)
hex ::= [0-9a-fA-F]
string ::= "\"" char* "\""
"#;
pub const REPLY_GRAMMAR_ROOT: &str = "root";

/// GBNF grammar for a one-line message summary.
pub const SUMMARY_GBNF: &str = r#"root ::= "{" ws "\"summary\":" ws string ws "}"
ws ::= [ \t\n]*
char ::= [^"\\] | "\\" (["\\/bfnrt] | "u" hex hex hex hex)
hex ::= [0-9a-fA-F]
string ::= "\"" char* "\""
"#;
pub const SUMMARY_GRAMMAR_ROOT: &str = "root";

/// GBNF grammar for thread-level meeting extraction. Same one-line-rule-body caveat as the
/// other grammars here.
///
/// `starts_at` is constrained to a literal ISO 8601 digit shape rather than a free string:
/// a small on-device model will otherwise happily emit "next Thursday" or a malformed date,
/// and a date we cannot parse is a calendar entry we cannot place. Making the shape
/// unproducible is far more reliable than validating after the fact.
pub const MEETING_GBNF: &str = r#"root ::= ( "{" ws "\"has_meeting\":" ws boolean "," ws "\"kind\":" ws kind "," ws "\"title\":" ws string "," ws "\"starts_at\":" ws starts-at "," ws "\"duration_minutes\":" ws duration "," ws "\"join_url\":" ws (string | "null") "," ws "\"confidence\":" ws confidence ws "}" )
ws ::= [ \t\n]*
boolean ::= "true" | "false"
kind ::= "\"confirmed\"" | "\"possible\"" | "\"none\""
confidence ::= "\"high\"" | "\"medium\"" | "\"low\""
d ::= [0-9]
starts-at ::= "\"" d d d d "-" d d "-" d d "T" d d ":" d d "\""
duration ::= d | d d | d d d | d d d d
char ::= [^"\\] | "\\" (["\\/bfnrt] | "u" hex hex hex hex)
hex ::= [0-9a-fA-F]
string ::= "\"" char* "\""
"#;
pub const MEETING_GRAMMAR_ROOT: &str = "root";

/// GBNF grammar for interpreting a spoken command: one intent from a fixed list plus a free-text
/// query (search words, a position, or a sender/topic). Mirrors `ModelIntent` in src/voice.ts.
pub const VOICE_GBNF: &str = r#"root ::= "{" ws "\"intent\":" ws intent ws "," ws "\"query\":" ws string ws "}"
intent ::= "\"read\"" | "\"read_summary\"" | "\"read_details\"" | "\"stop\"" | "\"reply\"" | "\"back\"" | "\"settings\"" | "\"mark_read\"" | "\"mark_unread\"" | "\"done\"" | "\"reopen\"" | "\"search\"" | "\"clear_search\"" | "\"open_number\"" | "\"open_match\"" | "\"next\"" | "\"previous\"" | "\"sync\"" | "\"quarantine\"" | "\"inbox\"" | "\"help\"" | "\"unknown\""
ws ::= [ \t\n]*
char ::= [^"\\] | "\\" (["\\/bfnrt] | "u" hex hex hex hex)
hex ::= [0-9a-fA-F]
string ::= "\"" char* "\""
"#;
pub const VOICE_GRAMMAR_ROOT: &str = "root";
