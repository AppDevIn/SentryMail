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
