//! /svc/sqlite and /svc/tools clients.

use json::Json;
use sysroot as rt;

// ── service clients (sqlite + tools) ─────────────────────────────────────────

pub(crate) fn svc_json(service: &str, req: &Json) -> Option<Json> {
    let conn = rt::svc_connect(service).ok()?;
    let body = json::to_string(req);
    let fd = match rt::svc_call(conn, body.as_bytes(), &[]) {
        Ok(fd) => fd,
        Err(_) => {
            let _ = rt::close(conn);
            return None;
        }
    };
    let out = match crate::fsutil::read_all_fd(fd) {
        Ok(b) => b,
        Err(_) => {
            let _ = rt::close(fd);
            let _ = rt::close(conn);
            return None;
        }
    };
    let _ = rt::close(fd);
    let _ = rt::close(conn);
    let s = core::str::from_utf8(&out).ok()?;
    json::parse(s).ok()
}

pub(crate) fn sqlite_call(req: Json) -> Option<Json> {
    svc_json("sqlite", &req)
}

pub(crate) fn tools_call(address: &str, args: Json) -> Option<Json> {
    let req = crate::jsonx::j_obj(alloc::vec![
        ("op".into(), Json::Str("call".into())),
        ("address".into(), Json::Str(address.into())),
        ("args".into(), args),
    ]);
    svc_json("tools", &req)
}

pub(crate) fn sqlite_open(path: &str) -> bool {
    let req = crate::jsonx::j_obj(alloc::vec![
        ("v".into(), Json::Num(1.0)),
        ("op".into(), Json::Str("open".into())),
        ("path".into(), Json::Str(path.into())),
    ]);
    match sqlite_call(req) {
        Some(r) => crate::jsonx::j_get_bool(&r, "ok"),
        None => false,
    }
}

pub(crate) fn sqlite_exec(sql: &str) -> bool {
    let req = crate::jsonx::j_obj(alloc::vec![
        ("v".into(), Json::Num(1.0)),
        ("op".into(), Json::Str("exec".into())),
        ("sql".into(), Json::Str(sql.into())),
    ]);
    match sqlite_call(req) {
        Some(r) => crate::jsonx::j_get_bool(&r, "ok"),
        None => false,
    }
}

pub(crate) fn sqlite_query(sql: &str) -> Option<Json> {
    let req = crate::jsonx::j_obj(alloc::vec![
        ("v".into(), Json::Num(1.0)),
        ("op".into(), Json::Str("query".into())),
        ("sql".into(), Json::Str(sql.into())),
    ]);
    let r = sqlite_call(req)?;
    if !crate::jsonx::j_get_bool(&r, "ok") {
        return None;
    }
    Some(r)
}

pub(crate) fn sqlite_close() {
    let req = crate::jsonx::j_obj(alloc::vec![
        ("v".into(), Json::Num(1.0)),
        ("op".into(), Json::Str("close".into())),
    ]);
    let _ = sqlite_call(req);
}

pub(crate) fn apply_schema(schema_sql: &str) {
    for stmt in schema_sql.split(';') {
        let s = stmt.trim();
        if s.is_empty() || s.starts_with("--") {
            continue;
        }
        let _ = sqlite_exec(s);
    }
}

