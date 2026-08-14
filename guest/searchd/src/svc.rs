//! /svc/sqlite and /svc/tools clients.
//!
//! SQLite is **session-stateful**: open/exec/query/close must share one
//! `svc_connect` fd. A new connection per op leaves every exec with
//! "no open database". Handlers use the held-connection sequence:
//! `sqlite_open` → `sqlite_exec`/`sqlite_query`… → `sqlite_close`.
//!
//! Tools calls are stateless and use one-shot connects.

use alloc::format;
use alloc::string::String;
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

/// Execute SQL on the held connection. `Ok(())` when sqlite reports ok;
/// `Err(message)` carries the service error string when present.
pub(crate) fn sqlite_exec_result(sql: &str) -> Result<(), String> {
    let Some(conn) = held() else {
        return Err(String::from("no open database"));
    };
    let req = crate::jsonx::j_obj(alloc::vec![
        ("v".into(), Json::Num(1.0)),
        ("op".into(), Json::Str("exec".into())),
        ("sql".into(), Json::Str(sql.into())),
    ]);
    match svc_call_on(conn, &req) {
        Some(r) if crate::jsonx::j_get_bool(&r, "ok") => Ok(()),
        Some(r) => {
            let msg = crate::jsonx::j_get_str(&r, "error").unwrap_or("sqlite exec failed");
            Err(String::from(msg))
        }
        None => Err(String::from("sqlite exec transport failed")),
    }
}

pub(crate) fn sqlite_exec(sql: &str) -> bool {
    sqlite_exec_result(sql).is_ok()
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

/// Apply the product schema as a single SQLite script.
///
/// AgentOS `/svc/sqlite` `exec` uses `sqlite3_exec`, which runs one or more
/// statements. Splitting on `;` is incorrect: trigger bodies contain internal
/// semicolons, and comment-leading fragments would skip virtual-table DDL.
/// Errors are propagated (no silent discard).
pub(crate) fn apply_schema(schema_sql: &str) -> Result<(), String> {
    let sql = schema_sql.trim();
    if sql.is_empty() {
        return Err(String::from("schemaSql is empty"));
    }
    match sqlite_exec_result(sql) {
        Ok(()) => Ok(()),
        Err(e) => Err(format!("schema DDL execution failed: {}", e)),
    }
}

/// Objects that must exist after a successful cold configure / candidate refresh.
const REQUIRED_SCHEMA_OBJECTS: &[(&str, &str)] = &[
    ("table", "chunks_fts"),
    ("table", "chunk_vec"),
    ("trigger", "chunks_fts_insert"),
    ("trigger", "chunks_fts_delete"),
    ("trigger", "chunks_fts_update"),
];

fn master_object_exists(kind: &str, name: &str) -> bool {
    let sql = format!(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = {} AND name = {} LIMIT 1",
        crate::sql_safe::sql_quote_string(kind),
        crate::sql_safe::sql_quote_string(name),
    );
    let Some(r) = sqlite_query(&sql) else {
        return false;
    };
    let Some(rows) = r.get("rows").and_then(|x| x.as_arr()) else {
        return false;
    };
    !rows.is_empty()
}

/// Fail-closed postcondition: FTS, VANN, and the three content-sync triggers exist.
pub(crate) fn schema_postconditions_ok() -> Result<(), String> {
    let mut missing: Vec<&str> = Vec::new();
    for (kind, name) in REQUIRED_SCHEMA_OBJECTS {
        if !master_object_exists(kind, name) {
            missing.push(*name);
        }
    }
    if missing.is_empty() {
        Ok(())
    } else {
        let mut msg = String::from("schema postconditions failed; missing:");
        for name in missing {
            msg.push(' ');
            msg.push_str(name);
        }
        Err(msg)
    }
}

/// Open path, apply schema, verify FTS/VANN/triggers. Closes the connection on error.
/// Caller may keep the connection open on success for further DDL/DML.
pub(crate) fn ensure_schema(path: &str, schema_sql: &str) -> Result<(), String> {
    if !sqlite_open(path) {
        return Err(String::from("failed to open sqlite database"));
    }
    if let Err(e) = apply_schema(schema_sql) {
        sqlite_close();
        return Err(e);
    }
    if let Err(e) = schema_postconditions_ok() {
        sqlite_close();
        return Err(e);
    }
    Ok(())
}
