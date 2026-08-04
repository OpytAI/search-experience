//! Audited SQL / FTS5 string construction for searchd.
//!
//! The guest sqlite client does not expose bound parameters on every path, so
//! all visitor/collection text interpolated into SQL must go through these
//! helpers. They never invent statement structure from user input.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

/// Escape a value for a SQL string literal and wrap it in single quotes.
/// Internal `'` becomes `''` (SQL standard). Result is always `'…'`.
pub(crate) fn sql_quote_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            out.push('\'');
            out.push('\'');
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Quote one FTS5 token as a double-quoted literal and escape internal `"`.
/// Does not add a prefix `*` — callers that want prefix match append it.
pub(crate) fn fts_quote_token(token: &str) -> String {
    let mut out = String::with_capacity(token.len() + 2);
    out.push('"');
    for ch in token.chars() {
        if ch == '"' {
            out.push('"');
            out.push('"');
        } else {
            out.push(ch);
        }
    }
    out.push('"');
    out
}

/// Build a conservative FTS5 MATCH expression from free-text user input.
///
/// - Normalizes ASCII letters to lowercase (Unicode left as-is lowercased per char when possible)
/// - Keeps only alphanumeric / `_` / `-` token runs
/// - Caps at `max_tokens` (default 16)
/// - Each token is double-quoted with internal quotes escaped, then `*` for prefix
/// - Tokens are joined with ` AND `
///
/// Returns empty string when there are no usable tokens (caller must not run MATCH).
pub(crate) fn build_fts_match_query(input: &str, max_tokens: usize) -> String {
    let max = if max_tokens == 0 { 16 } else { max_tokens };
    let mut terms: Vec<String> = Vec::new();
    let mut cur = String::new();
    let flush = |cur: &mut String, terms: &mut Vec<String>, max: usize| {
        if cur.is_empty() {
            return;
        }
        if terms.len() >= max {
            cur.clear();
            return;
        }
        // Dedup while preserving order
        let token = cur.clone();
        cur.clear();
        if terms.iter().any(|t| t == &token) {
            return;
        }
        terms.push(token);
    };

    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            // FTS5 unicode61 is case-insensitive for ASCII; store lowercase for stable MATCH text.
            if ch.is_ascii_uppercase() {
                cur.push(ch.to_ascii_lowercase());
            } else {
                cur.push(ch);
            }
        } else {
            flush(&mut cur, &mut terms, max);
        }
    }
    flush(&mut cur, &mut terms, max);

    if terms.is_empty() {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::with_capacity(terms.len());
    for t in &terms {
        parts.push(format!("{}*", fts_quote_token(t)));
    }
    parts.join(" AND ")
}

/// Format a float vector as `vec_f32('[v0,v1,...]')` for VANN SQL.
/// Rejects non-finite values by substituting 0.0 (caller should prefer failing embed).
pub(crate) fn sql_vec_f32(values: &[f64]) -> String {
    let mut body = String::from("[");
    for (i, v) in values.iter().enumerate() {
        if i > 0 {
            body.push(',');
        }
        let x = if v.is_finite() { *v } else { 0.0 };
        // Debug formatting is enough precision for 384-d cosine search.
        body.push_str(&format!("{}", x));
    }
    body.push(']');
    format!("vec_f32({})", sql_quote_string(&body))
}

/// Bound a positive integer limit for SQL (never trust raw request ints blindly).
pub(crate) fn clamp_limit(value: u64, default: u64, max: u64) -> u64 {
    let v = if value == 0 { default } else { value };
    if v > max {
        max
    } else {
        v
    }
}
