//! Small JSON helpers over the guest `json` crate.

use alloc::string::String;
use alloc::vec::Vec;
use json::Json;

// ── tiny JSON helpers ────────────────────────────────────────────────────────

pub(crate) fn j_str(v: &Json) -> Option<&str> {
    v.as_str()
}

pub(crate) fn j_get_str<'a>(obj: &'a Json, k: &str) -> Option<&'a str> {
    obj.get(k).and_then(j_str)
}

pub(crate) fn j_get_bool(obj: &Json, k: &str) -> bool {
    obj.get(k).and_then(|v| v.as_bool()).unwrap_or(false)
}

pub(crate) fn j_get_u64(obj: &Json, k: &str, default: u64) -> u64 {
    obj.get(k).and_then(|v| v.as_u64()).unwrap_or(default)
}

pub(crate) fn j_obj(pairs: Vec<(String, Json)>) -> Json {
    Json::Obj(pairs)
}

pub(crate) fn ok_resp(id: &str, op: &str, extra: Vec<(String, Json)>) -> Json {
    let mut pairs = alloc::vec![
        ("v".into(), Json::Num(1.0)),
        ("id".into(), Json::Str(id.into())),
        ("ok".into(), Json::Bool(true)),
        ("op".into(), Json::Str(op.into())),
    ];
    pairs.extend(extra);
    j_obj(pairs)
}

pub(crate) fn err_resp(id: &str, code: &str, message: &str) -> Json {
    j_obj(alloc::vec![
        ("v".into(), Json::Num(1.0)),
        ("id".into(), Json::Str(id.into())),
        ("ok".into(), Json::Bool(false)),
        ("error".into(), j_obj(alloc::vec![
            ("code".into(), Json::Str(code.into())),
            ("message".into(), Json::Str(message.into())),
        ])),
    ])
}

