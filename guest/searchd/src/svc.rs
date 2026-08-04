//! /svc/sqlite and /svc/tools clients.
//!
//! SQLite is **session-stateful**: open/exec/query/close must share one
//! `svc_connect` fd. A new connection per op leaves every exec with
//! "no open database". Handlers use the held-connection sequence:
//! `sqlite_open` → `sqlite_exec`/`sqlite_query`… → `sqlite_close`.
//!
//! Tools calls are stateless and use one-shot connects.

use alloc::vec::Vec;
use json::Json;
use sysroot as rt;

// ── low-level ────────────────────────────────────────────────────────────────

fn svc_call_on(conn: i32, req: &Json) -> Option<Json> {
    let body = json::to_string(req);
    let fd = match rt::svc_call(conn, body.as_bytes(), &[]) {
        Ok(fd) => fd,
        Err(_) => return None,
    };
    let out = match crate::fsutil::read_all_fd(fd) {
        Ok(b) => b,
        Err(_) => {
            let _ = rt::close(fd);
            return None;
        }
    };
    let _ = rt::close(fd);
    let s = core::str::from_utf8(&out).ok()?;
    json::parse(s).ok()
}

fn svc_call_once(service: &str, req: &Json) -> Option<Json> {
    let conn = rt::svc_connect(service).ok()?;
    let out = svc_call_on(conn, req);
    let _ = rt::close(conn);
    out
}

// ── tools ────────────────────────────────────────────────────────────────────

pub(crate) fn tools_call(address: &str, args: Json) -> Option<Json> {
    let req = crate::jsonx::j_obj(alloc::vec![
        ("op".into(), Json::Str("call".into())),
        ("address".into(), Json::Str(address.into())),
        ("args".into(), args),
    ]);
    svc_call_once("tools", &req)
}

// ── sqlite held session ──────────────────────────────────────────────────────
//
// Single in-flight open connection for the searchd task. Handlers always
// open → work → close; concurrent searchd requests are serialized by the
// service loop so this is safe.

static mut HELD_CONN: i32 = -1;
static mut HELD_OPEN: bool = false;

fn held() -> Option<i32> {
    let (conn, open) = unsafe { (HELD_CONN, HELD_OPEN) };
    if conn >= 0 && open {
        Some(conn)
    } else {
        None
    }
}

pub(crate) fn sqlite_open(path: &str) -> bool {
    sqlite_close();
    let Ok(conn) = rt::svc_connect("sqlite") else {
        return false;
    };
    let req = crate::jsonx::j_obj(alloc::vec![
        ("v".into(), Json::Num(1.0)),
        ("op".into(), Json::Str("open".into())),
        ("path".into(), Json::Str(path.into())),
    ]);
    match svc_call_on(conn, &req) {
        Some(r) if crate::jsonx::j_get_bool(&r, "ok") => {
            unsafe {
                HELD_CONN = conn;
                HELD_OPEN = true;
            }
            true
        }
        _ => {
            let _ = rt::close(conn);
            false
        }
    }
}

pub(crate) fn sqlite_exec(sql: &str) -> bool {
    let Some(conn) = held() else {
        return false;
    };
    let req = crate::jsonx::j_obj(alloc::vec![
        ("v".into(), Json::Num(1.0)),
        ("op".into(), Json::Str("exec".into())),
        ("sql".into(), Json::Str(sql.into())),
    ]);
    match svc_call_on(conn, &req) {
        Some(r) => crate::jsonx::j_get_bool(&r, "ok"),
        None => false,
    }
}

pub(crate) fn sqlite_query(sql: &str) -> Option<Json> {
    let conn = held()?;
    let req = crate::jsonx::j_obj(alloc::vec![
        ("v".into(), Json::Num(1.0)),
        ("op".into(), Json::Str("query".into())),
        ("sql".into(), Json::Str(sql.into())),
    ]);
    let r = svc_call_on(conn, &req)?;
    if !crate::jsonx::j_get_bool(&r, "ok") {
        return None;
    }
    Some(r)
}

pub(crate) fn sqlite_close() {
    let (conn, open) = unsafe { (HELD_CONN, HELD_OPEN) };
    if conn < 0 {
        return;
    }
    if open {
        let req = crate::jsonx::j_obj(alloc::vec![
            ("v".into(), Json::Num(1.0)),
            ("op".into(), Json::Str("close".into())),
        ]);
        let _ = svc_call_on(conn, &req);
    }
    let _ = rt::close(conn);
    unsafe {
        HELD_CONN = -1;
        HELD_OPEN = false;
    }
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

// keep Vec in scope for read_all_fd returns if needed by callers of this module
#[allow(dead_code)]
fn _unused_vec() -> Vec<u8> {
    Vec::new()
}
