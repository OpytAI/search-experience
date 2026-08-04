//! Durable JSON state under /var/searchd.

use alloc::vec::Vec;
use json::Json;

// ── state (JSON file; durable under /var/searchd, rides MCSN) ────────────────

pub(crate) fn load_state() -> Json {
    if let Some(bytes) = crate::fsutil::read_file(crate::paths::META_PATH) {
        if let Ok(s) = core::str::from_utf8(&bytes) {
            if let Ok(j) = json::parse(s) {
                return j;
            }
        }
    }
    crate::jsonx::j_obj(alloc::vec![
        ("phase".into(), Json::Str("unconfigured".into())),
        ("lexicalReady".into(), Json::Bool(false)),
        ("semanticReady".into(), Json::Bool(false)),
        ("generation".into(), Json::Str("gen-1".into())),
        ("pages".into(), Json::Num(0.0)),
        ("chunks".into(), Json::Num(0.0)),
        ("embeddedChunks".into(), Json::Num(0.0)),
        ("writeCandidate".into(), Json::Bool(false)),
        ("compatibilityKey".into(), Json::Str("".into())),
        ("modelFingerprint".into(), Json::Str("".into())),
        ("pageOrigin".into(), Json::Str("".into())),
        ("schemaSql".into(), Json::Str("".into())),
        ("message".into(), Json::Str("".into())),
        ("collections".into(), Json::Arr(Vec::new())),
        ("queue".into(), Json::Arr(Vec::new())),
        ("visited".into(), Json::Arr(Vec::new())),
        ("robots".into(), Json::Obj(Vec::new())),
        ("sitemapSeeded".into(), Json::Arr(Vec::new())),
        ("pagesByCollection".into(), Json::Obj(Vec::new())),
    ])
}

pub(crate) fn save_state(state: &Json) {
    let s = json::to_string(state);
    let _ = crate::fsutil::write_file(crate::paths::META_PATH, s.as_bytes());
}

pub(crate) fn status_body(state: &Json) -> Json {
    crate::jsonx::j_obj(alloc::vec![
        ("phase".into(), state.get("phase").cloned().unwrap_or(Json::Str("unconfigured".into()))),
        ("lexicalReady".into(), Json::Bool(crate::jsonx::j_get_bool(state, "lexicalReady"))),
        ("semanticReady".into(), Json::Bool(crate::jsonx::j_get_bool(state, "semanticReady"))),
        ("generation".into(), Json::Str(crate::jsonx::j_get_str(state, "generation").unwrap_or("gen-1").into())),
        ("pages".into(), Json::Num(crate::jsonx::j_get_u64(state, "pages", 0) as f64)),
        ("chunks".into(), Json::Num(crate::jsonx::j_get_u64(state, "chunks", 0) as f64)),
        ("embeddedChunks".into(), Json::Num(crate::jsonx::j_get_u64(state, "embeddedChunks", 0) as f64)),
        ("message".into(), Json::Str(crate::jsonx::j_get_str(state, "message").unwrap_or("").into())),
        ("compatibilityKey".into(), Json::Str(crate::jsonx::j_get_str(state, "compatibilityKey").unwrap_or("").into())),
        ("collections".into(), state.get("collections").cloned().unwrap_or(Json::Arr(Vec::new()))),
    ])
}

pub(crate) fn set_field(state: &mut Json, key: &str, value: Json) {
    if let Json::Obj(ref mut pairs) = state {
        if let Some((_, v)) = pairs.iter_mut().find(|(k, _)| k == key) {
            *v = value;
        } else {
            pairs.push((key.into(), value));
        }
    }
}

