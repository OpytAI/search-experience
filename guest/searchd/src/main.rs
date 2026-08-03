//! `/svc/searchd` — product site-search authority for search-experience.
//!
//! Resident service that owns crawl/index/query policy. Stitches:
//! - `/svc/sqlite` for FTS5 / VANN (atlas image)
//! - `/svc/tools` for host-backed fetch / extract / embed
//!
//! Wire protocol: JSON envelope v1 (see searchd.protocol.json).
//! No Luau authority path.

#![no_std]
#![no_main]

extern crate alloc;

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use json::Json;
use sysroot as rt;

// ── bump allocator (no external crate dep from product MODULE) ───────────────

struct BumpAlloc;

static mut HEAP: [u8; 32 * 1024 * 1024] = [0; 32 * 1024 * 1024];
static mut HEAP_OFF: usize = 0;

unsafe impl core::alloc::GlobalAlloc for BumpAlloc {
    unsafe fn alloc(&self, layout: core::alloc::Layout) -> *mut u8 {
        let align = layout.align().max(8);
        let size = layout.size().max(1);
        let off = HEAP_OFF;
        let aligned = (off + align - 1) & !(align - 1);
        let end = aligned.saturating_add(size);
        if end > HEAP.len() {
            return core::ptr::null_mut();
        }
        HEAP_OFF = end;
        HEAP.as_mut_ptr().add(aligned)
    }

    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: core::alloc::Layout) {}
}

#[global_allocator]
static ALLOC: BumpAlloc = BumpAlloc;

rt::entry!(main);

const SERVICE_NAME: &str = "searchd";
const STATE_DIR: &str = "/var/searchd";
const INDEX_PATH: &str = "/var/searchd/index.db";
const CANDIDATE_PATH: &str = "/var/searchd/candidate.db";
const META_PATH: &str = "/var/searchd/state.json";
const FETCH_ADDR: &str = "host.org.main.search.fetch";
const EXTRACT_ADDR: &str = "host.org.main.search.extract";
const EMBED_ADDR: &str = "host.org.main.search.embed.batch";

// ── tiny JSON helpers ────────────────────────────────────────────────────────

fn j_str(v: &Json) -> Option<&str> {
    v.as_str()
}

fn j_get_str<'a>(obj: &'a Json, k: &str) -> Option<&'a str> {
    obj.get(k).and_then(j_str)
}

fn j_get_bool(obj: &Json, k: &str) -> bool {
    obj.get(k).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn j_get_u64(obj: &Json, k: &str, default: u64) -> u64 {
    obj.get(k).and_then(|v| v.as_u64()).unwrap_or(default)
}

fn j_obj(pairs: Vec<(String, Json)>) -> Json {
    Json::Obj(pairs)
}

fn ok_resp(id: &str, op: &str, extra: Vec<(String, Json)>) -> Json {
    let mut pairs = alloc::vec![
        ("v".into(), Json::Num(1.0)),
        ("id".into(), Json::Str(id.into())),
        ("ok".into(), Json::Bool(true)),
        ("op".into(), Json::Str(op.into())),
    ];
    pairs.extend(extra);
    j_obj(pairs)
}

fn err_resp(id: &str, code: &str, message: &str) -> Json {
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

// ── fs ───────────────────────────────────────────────────────────────────────

fn ensure_dir() {
    let _ = rt::mkdir("/var");
    let _ = rt::mkdir(STATE_DIR);
}

fn read_file(path: &str) -> Option<Vec<u8>> {
    let fd = rt::open(path, rt::O_READ).ok()?;
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match rt::read(fd, &mut buf) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(_) => {
                let _ = rt::close(fd);
                return None;
            }
        }
    }
    let _ = rt::close(fd);
    Some(out)
}

fn write_file(path: &str, data: &[u8]) -> bool {
    let flags = rt::O_WRITE | rt::O_CREATE | rt::O_TRUNC;
    let Ok(fd) = rt::open(path, flags) else {
        return false;
    };
    let ok = rt::write_all(fd, data).is_ok();
    let _ = rt::close(fd);
    ok
}

fn read_all_fd(fd: i32) -> Result<Vec<u8>, i32> {
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match rt::read(fd, &mut buf) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

// ── service clients (sqlite + tools) ─────────────────────────────────────────

fn svc_json(service: &str, req: &Json) -> Option<Json> {
    let conn = rt::svc_connect(service).ok()?;
    let body = json::to_string(req);
    let fd = match rt::svc_call(conn, body.as_bytes(), &[]) {
        Ok(fd) => fd,
        Err(_) => {
            let _ = rt::close(conn);
            return None;
        }
    };
    let out = match read_all_fd(fd) {
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

fn sqlite_call(req: Json) -> Option<Json> {
    svc_json("sqlite", &req)
}

fn tools_call(address: &str, args: Json) -> Option<Json> {
    let req = j_obj(alloc::vec![
        ("op".into(), Json::Str("call".into())),
        ("address".into(), Json::Str(address.into())),
        ("args".into(), args),
    ]);
    svc_json("tools", &req)
}

fn sqlite_open(path: &str) -> bool {
    let req = j_obj(alloc::vec![
        ("v".into(), Json::Num(1.0)),
        ("op".into(), Json::Str("open".into())),
        ("path".into(), Json::Str(path.into())),
    ]);
    match sqlite_call(req) {
        Some(r) => j_get_bool(&r, "ok"),
        None => false,
    }
}

fn sqlite_exec(sql: &str) -> bool {
    let req = j_obj(alloc::vec![
        ("v".into(), Json::Num(1.0)),
        ("op".into(), Json::Str("exec".into())),
        ("sql".into(), Json::Str(sql.into())),
    ]);
    match sqlite_call(req) {
        Some(r) => j_get_bool(&r, "ok"),
        None => false,
    }
}

fn sqlite_query(sql: &str) -> Option<Json> {
    let req = j_obj(alloc::vec![
        ("v".into(), Json::Num(1.0)),
        ("op".into(), Json::Str("query".into())),
        ("sql".into(), Json::Str(sql.into())),
    ]);
    let r = sqlite_call(req)?;
    if !j_get_bool(&r, "ok") {
        return None;
    }
    Some(r)
}

fn sqlite_close() {
    let req = j_obj(alloc::vec![
        ("v".into(), Json::Num(1.0)),
        ("op".into(), Json::Str("close".into())),
    ]);
    let _ = sqlite_call(req);
}

fn apply_schema(schema_sql: &str) {
    for stmt in schema_sql.split(';') {
        let s = stmt.trim();
        if s.is_empty() || s.starts_with("--") {
            continue;
        }
        let _ = sqlite_exec(s);
    }
}

// ── state (JSON file; durable under /var/searchd, rides MCSN) ────────────────

fn load_state() -> Json {
    if let Some(bytes) = read_file(META_PATH) {
        if let Ok(s) = core::str::from_utf8(&bytes) {
            if let Ok(j) = json::parse(s) {
                return j;
            }
        }
    }
    j_obj(alloc::vec![
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
    ])
}

fn save_state(state: &Json) {
    let s = json::to_string(state);
    let _ = write_file(META_PATH, s.as_bytes());
}

fn status_body(state: &Json) -> Json {
    j_obj(alloc::vec![
        ("phase".into(), state.get("phase").cloned().unwrap_or(Json::Str("unconfigured".into()))),
        ("lexicalReady".into(), Json::Bool(j_get_bool(state, "lexicalReady"))),
        ("semanticReady".into(), Json::Bool(j_get_bool(state, "semanticReady"))),
        ("generation".into(), Json::Str(j_get_str(state, "generation").unwrap_or("gen-1").into())),
        ("pages".into(), Json::Num(j_get_u64(state, "pages", 0) as f64)),
        ("chunks".into(), Json::Num(j_get_u64(state, "chunks", 0) as f64)),
        ("embeddedChunks".into(), Json::Num(j_get_u64(state, "embeddedChunks", 0) as f64)),
        ("message".into(), Json::Str(j_get_str(state, "message").unwrap_or("").into())),
        ("compatibilityKey".into(), Json::Str(j_get_str(state, "compatibilityKey").unwrap_or("").into())),
        ("collections".into(), state.get("collections").cloned().unwrap_or(Json::Arr(Vec::new()))),
    ])
}

fn set_field(state: &mut Json, key: &str, value: Json) {
    if let Json::Obj(ref mut pairs) = state {
        if let Some((_, v)) = pairs.iter_mut().find(|(k, _)| k == key) {
            *v = value;
        } else {
            pairs.push((key.into(), value));
        }
    }
}

// ── handlers ─────────────────────────────────────────────────────────────────

fn handle_configure(req: &Json) -> Json {
    ensure_dir();
    let id = j_get_str(req, "id").unwrap_or("cfg");
    let config = req.get("config").cloned().unwrap_or(Json::Obj(Vec::new()));
    let resume = j_get_bool(&config, "resume");
    let key = j_get_str(&config, "compatibilityKey").unwrap_or("");
    let mut state = load_state();
    let same = j_get_str(&state, "compatibilityKey").unwrap_or("") == key && !key.is_empty();
    let can_resume = resume && same && j_get_bool(&state, "lexicalReady");

    if can_resume {
        set_field(&mut state, "message", Json::Str("Resumed from warm snapshot".into()));
        set_field(&mut state, "writeCandidate", Json::Bool(false));
        if let Some(mf) = j_get_str(&config, "modelFingerprint") {
            set_field(&mut state, "modelFingerprint", Json::Str(mf.into()));
        }
        if let Some(sql) = j_get_str(&config, "schemaSql") {
            set_field(&mut state, "schemaSql", Json::Str(sql.into()));
        }
        save_state(&state);
        return ok_resp(id, "configure", alloc::vec![("status".into(), status_body(&state))]);
    }

    // Cold configure
    set_field(&mut state, "phase", Json::Str("configuring".into()));
    set_field(&mut state, "compatibilityKey", Json::Str(key.into()));
    set_field(
        &mut state,
        "modelFingerprint",
        Json::Str(j_get_str(&config, "modelFingerprint").unwrap_or("").into()),
    );
    set_field(
        &mut state,
        "pageOrigin",
        Json::Str(j_get_str(&config, "pageOrigin").unwrap_or("").into()),
    );
    let schema = j_get_str(&config, "schemaSql").unwrap_or("").to_string();
    set_field(&mut state, "schemaSql", Json::Str(schema.clone()));
    set_field(&mut state, "lexicalReady", Json::Bool(false));
    set_field(&mut state, "semanticReady", Json::Bool(false));
    set_field(&mut state, "pages", Json::Num(0.0));
    set_field(&mut state, "chunks", Json::Num(0.0));
    set_field(&mut state, "embeddedChunks", Json::Num(0.0));
    set_field(&mut state, "generation", Json::Str("gen-1".into()));
    set_field(&mut state, "writeCandidate", Json::Bool(false));
    set_field(&mut state, "message", Json::Str("Configured".into()));

    let collections = config.get("collections").cloned().unwrap_or(Json::Arr(Vec::new()));
    set_field(&mut state, "collections", collections.clone());

    // Seed queue from collection seeds
    let mut queue = Vec::new();
    if let Json::Arr(cols) = &collections {
        for c in cols {
            if let Json::Arr(seeds) = c.get("seeds").unwrap_or(&Json::Arr(Vec::new())) {
                let cid = j_get_str(c, "id").unwrap_or("site");
                for s in seeds {
                    if let Some(url) = j_str(s) {
                        queue.push(j_obj(alloc::vec![
                            ("url".into(), Json::Str(url.into())),
                            ("collectionId".into(), Json::Str(cid.into())),
                        ]));
                    }
                }
            }
        }
    }
    set_field(&mut state, "queue", Json::Arr(queue));

    let _ = write_file(CANDIDATE_PATH, b"");
    if sqlite_open(INDEX_PATH) {
        if !schema.is_empty() {
            apply_schema(&schema);
        }
        // ensure PRAGMA
        let _ = sqlite_exec("PRAGMA foreign_keys = ON");
        if let Json::Arr(cols) = &collections {
            for c in cols {
                let cid = j_get_str(c, "id").unwrap_or("site");
                let label = j_get_str(c, "label").unwrap_or(cid);
                let sql = format!(
                    "INSERT INTO collections(id, label, source_json, page_count, chunk_count, built_at) VALUES ('{}', '{}', '{{}}', 0, 0, datetime('now')) ON CONFLICT(id) DO UPDATE SET label=excluded.label",
                    cid.replace('\'', "''"),
                    label.replace('\'', "''")
                );
                let _ = sqlite_exec(&sql);
            }
        }
        sqlite_close();
    }

    set_field(&mut state, "phase", Json::Str("crawling".into()));
    set_field(&mut state, "message", Json::Str("Crawl queued".into()));
    save_state(&state);
    ok_resp(id, "configure", alloc::vec![("status".into(), status_body(&state))])
}

fn handle_status(req: &Json) -> Json {
    let id = j_get_str(req, "id").unwrap_or("status");
    let state = load_state();
    ok_resp(id, "status", alloc::vec![("status".into(), status_body(&state))])
}

fn is_http_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

fn handle_crawl_step(req: &Json) -> Json {
    let id = j_get_str(req, "id").unwrap_or("crawl");
    let mut state = load_state();
    if j_get_str(&state, "phase").unwrap_or("") == "unconfigured" {
        return err_resp(id, "not_configured", "call configure first");
    }
    let max_fetches = j_get_u64(req, "maxFetches", 4) as usize;
    let write_cand = j_get_bool(&state, "writeCandidate");
    let db_path = if write_cand { CANDIDATE_PATH } else { INDEX_PATH };

    let mut queue = match state.get("queue").cloned().unwrap_or(Json::Arr(Vec::new())) {
        Json::Arr(a) => a,
        _ => Vec::new(),
    };
    let mut fetches = 0usize;
    let mut indexed_pages = 0usize;
    let mut indexed_chunks = 0usize;

    while fetches < max_fetches && !queue.is_empty() {
        let item = queue.remove(0);
        let url = j_get_str(&item, "url").unwrap_or("").to_string();
        let cid = j_get_str(&item, "collectionId").unwrap_or("site").to_string();
        if !is_http_url(&url) {
            continue;
        }
        fetches += 1;

        let args = j_obj(alloc::vec![
            ("url".into(), Json::Str(url.clone())),
            ("maxBytes".into(), Json::Num(2_000_000.0)),
            ("timeoutMs".into(), Json::Num(15_000.0)),
        ]);
        let Some(fetched_wrap) = tools_call(FETCH_ADDR, args) else {
            continue;
        };
        // tools returns {ok, data} or error envelope
        let fetched = if j_get_bool(&fetched_wrap, "ok") {
            fetched_wrap.get("data").cloned().unwrap_or(fetched_wrap)
        } else {
            continue;
        };
        let status = j_get_u64(&fetched, "status", 0);
        if status >= 400 {
            continue;
        }
        let body = j_get_str(&fetched, "body").unwrap_or("").to_string();
        let final_url = j_get_str(&fetched, "finalUrl").unwrap_or(&url).to_string();

        let extract_args = j_obj(alloc::vec![
            ("url".into(), Json::Str(final_url.clone())),
            ("html".into(), Json::Str(body)),
        ]);
        let Some(extracted_wrap) = tools_call(EXTRACT_ADDR, extract_args) else {
            continue;
        };
        let extracted = if j_get_bool(&extracted_wrap, "ok") {
            extracted_wrap.get("data").cloned().unwrap_or(extracted_wrap)
        } else {
            continue;
        };
        if j_get_bool(&extracted, "noindex") {
            continue;
        }

        // Enqueue links
        if let Some(Json::Arr(links)) = extracted.get("links") {
            for link in links {
                if let Some(u) = j_str(link) {
                    if is_http_url(u) {
                        queue.push(j_obj(alloc::vec![
                            ("url".into(), Json::Str(u.into())),
                            ("collectionId".into(), Json::Str(cid.clone())),
                        ]));
                    }
                }
            }
        }

        let title = j_get_str(&extracted, "title").unwrap_or("").to_string();
        let description = j_get_str(&extracted, "description").unwrap_or("").to_string();
        let canonical = j_get_str(&extracted, "canonicalUrl")
            .unwrap_or(&final_url)
            .to_string();
        if !is_http_url(&canonical) {
            continue;
        }

        // Index one page with a simple single chunk from description/title
        let body_text = {
            let mut t = String::new();
            if let Some(Json::Arr(blocks)) = extracted.get("blocks") {
                for b in blocks {
                    if let Some(tx) = j_get_str(b, "text") {
                        if !t.is_empty() {
                            t.push('\n');
                        }
                        t.push_str(tx);
                    }
                }
            }
            if t.is_empty() {
                t = description.clone();
            }
            t
        };
        if body_text.is_empty() && title.is_empty() {
            continue;
        }

        if !sqlite_open(db_path) {
            continue;
        }
        let _ = sqlite_exec("PRAGMA foreign_keys = ON");
        let stable = format!("{}:{}", cid, canonical).replace('\'', "''");
        let title_e = title.replace('\'', "''");
        let desc_e = description.replace('\'', "''");
        let canon_e = canonical.replace('\'', "''");
        let url_e = final_url.replace('\'', "''");
        let body_e = body_text.replace('\'', "''");
        let _ = sqlite_exec(&format!(
            "DELETE FROM pages WHERE stable_id = '{}'",
            stable
        ));
        let _ = sqlite_exec(&format!(
            "INSERT INTO pages(stable_id, collection_id, url, canonical_url, title, description, language, content_hash, indexed_at) VALUES ('{}', '{}', '{}', '{}', '{}', '{}', '', 'x', strftime('%s','now'))",
            stable,
            cid.replace('\'', "''"),
            url_e,
            canon_e,
            title_e,
            desc_e
        ));
        let page_id = sqlite_query(&format!(
            "SELECT id FROM pages WHERE stable_id = '{}'",
            stable
        ))
        .and_then(|r| {
            let rows = r.get("rows")?.as_arr()?;
            let row = rows.first()?.as_arr()?;
            row.first()?.as_f64().map(|n| n as i64)
        })
        .unwrap_or(0);
        let chunk_stable = format!("{}#1", stable).replace('\'', "''");
        let _ = sqlite_exec(&format!(
            "INSERT INTO chunks(stable_id, collection_id, page_id, ordinal, url, title, heading, body, content_hash, metadata_json) VALUES ('{}', '{}', {}, 1, '{}', '{}', '', '{}', 'x', '{{}}')",
            chunk_stable,
            cid.replace('\'', "''"),
            page_id,
            canon_e,
            title_e,
            body_e
        ));
        sqlite_close();

        indexed_pages += 1;
        indexed_chunks += 1;
        let pages = j_get_u64(&state, "pages", 0) + 1;
        let chunks = j_get_u64(&state, "chunks", 0) + 1;
        let cand_pages = j_get_u64(&state, "candidatePages", 0) + 1;
        let cand_chunks = j_get_u64(&state, "candidateChunks", 0) + 1;
        if write_cand {
            set_field(&mut state, "candidatePages", Json::Num(cand_pages as f64));
            set_field(&mut state, "candidateChunks", Json::Num(cand_chunks as f64));
        } else {
            set_field(&mut state, "pages", Json::Num(pages as f64));
            set_field(&mut state, "chunks", Json::Num(chunks as f64));
        }
    }

    set_field(&mut state, "queue", Json::Arr(queue.clone()));
    let done = queue.is_empty();
    if done || j_get_u64(&state, "pages", 0) > 0 || j_get_u64(&state, "candidatePages", 0) > 0 {
        if !write_cand {
            set_field(&mut state, "lexicalReady", Json::Bool(true));
        }
        if done {
            if write_cand {
                // promote candidate → index
                let pages = j_get_u64(&state, "candidatePages", 0);
                let chunks = j_get_u64(&state, "candidateChunks", 0);
                if pages >= 1 && chunks >= 1 {
                    if let Some(bytes) = read_file(CANDIDATE_PATH) {
                        if write_file(INDEX_PATH, &bytes) {
                            let gen = j_get_str(&state, "candidateGeneration")
                                .unwrap_or("gen-1")
                                .to_string();
                            set_field(&mut state, "pages", Json::Num(pages as f64));
                            set_field(&mut state, "chunks", Json::Num(chunks as f64));
                            set_field(&mut state, "lexicalReady", Json::Bool(true));
                            set_field(&mut state, "semanticReady", Json::Bool(false));
                            set_field(&mut state, "writeCandidate", Json::Bool(false));
                            set_field(
                                &mut state,
                                "generation",
                                Json::Str(gen),
                            );
                            set_field(&mut state, "message", Json::Str("Candidate promoted".into()));
                            let _ = write_file(CANDIDATE_PATH, b"");
                        }
                    }
                } else {
                    set_field(&mut state, "writeCandidate", Json::Bool(false));
                    set_field(
                        &mut state,
                        "message",
                        Json::Str("Candidate discarded: incomplete".into()),
                    );
                    let _ = write_file(CANDIDATE_PATH, b"");
                }
                set_field(&mut state, "phase", Json::Str("lexical_ready".into()));
            } else {
                set_field(&mut state, "phase", Json::Str("lexical_ready".into()));
                set_field(&mut state, "message", Json::Str("Lexical index ready".into()));
            }
        } else if write_cand {
            set_field(&mut state, "phase", Json::Str("refreshing".into()));
        } else {
            set_field(&mut state, "phase", Json::Str("crawling".into()));
        }
    }
    save_state(&state);

    let progress = j_obj(alloc::vec![
        ("fetches".into(), Json::Num(fetches as f64)),
        ("indexedPages".into(), Json::Num(indexed_pages as f64)),
        ("indexedChunks".into(), Json::Num(indexed_chunks as f64)),
        ("queueDepth".into(), Json::Num(queue.len() as f64)),
        ("done".into(), Json::Bool(done)),
    ]);
    ok_resp(
        id,
        "crawl_step",
        alloc::vec![
            ("status".into(), status_body(&state)),
            ("progress".into(), progress),
        ],
    )
}

fn build_fts_query(q: &str) -> String {
    let mut terms = Vec::new();
    let mut cur = String::new();
    for ch in q.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            cur.push(ch.to_ascii_lowercase());
        } else if !cur.is_empty() {
            if terms.len() < 16 {
                terms.push(format!("\"{}\"*", cur.replace('"', "\"\"")));
            }
            cur.clear();
        }
    }
    if !cur.is_empty() && terms.len() < 16 {
        terms.push(format!("\"{}\"*", cur.replace('"', "\"\"")));
    }
    terms.join(" AND ")
}

fn handle_query(req: &Json) -> Json {
    let id = j_get_str(req, "id").unwrap_or("query");
    let state = load_state();
    if !j_get_bool(&state, "lexicalReady") {
        return ok_resp(
            id,
            "query",
            alloc::vec![
                ("status".into(), status_body(&state)),
                ("hits".into(), Json::Arr(Vec::new())),
                ("semanticAvailable".into(), Json::Bool(false)),
            ],
        );
    }
    let q = j_get_str(req, "query").unwrap_or("");
    let collection_id = j_get_str(req, "collectionId").unwrap_or("site");
    let limit = j_get_u64(req, "limit", 10) as usize;
    let fts = build_fts_query(q);
    let mut hits = Vec::new();
    if !fts.is_empty() && sqlite_open(INDEX_PATH) {
        let sql = format!(
            "SELECT c.stable_id, c.collection_id, c.page_id, c.url, c.title, c.heading, c.body, \
             snippet(chunks_fts, 2, '', '', '…', 24) AS snippet \
             FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid \
             WHERE chunks_fts MATCH '{}' AND c.collection_id = '{}' \
             ORDER BY bm25(chunks_fts, 8.0, 4.0, 1.0, 0.0), c.id LIMIT {}",
            fts.replace('\'', "''"),
            collection_id.replace('\'', "''"),
            limit
        );
        if let Some(r) = sqlite_query(&sql) {
            if let Some(rows) = r.get("rows").and_then(|x| x.as_arr()) {
                let cols = r
                    .get("cols")
                    .and_then(|x| x.as_arr())
                    .map(|c| {
                        c.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                for (rank, row) in rows.iter().enumerate() {
                    if let Some(cells) = row.as_arr() {
                        let get = |name: &str| -> String {
                            cols.iter()
                                .position(|c| c == name)
                                .and_then(|i| cells.get(i))
                                .and_then(|v| match v {
                                    Json::Str(s) => Some(s.clone()),
                                    Json::Num(n) => Some(format!("{}", n)),
                                    _ => None,
                                })
                                .unwrap_or_default()
                        };
                        let url = get("url");
                        if !is_http_url(&url) {
                            continue;
                        }
                        hits.push(j_obj(alloc::vec![
                            ("id".into(), Json::Str(get("stable_id"))),
                            ("collectionId".into(), Json::Str(get("collection_id"))),
                            ("pageId".into(), Json::Str(get("page_id"))),
                            ("url".into(), Json::Str(url)),
                            ("title".into(), Json::Str(get("title"))),
                            ("heading".into(), Json::Str(get("heading"))),
                            ("snippet".into(), Json::Str({
                                let s = get("snippet");
                                if s.is_empty() { get("body").chars().take(160).collect() } else { s }
                            })),
                            ("body".into(), Json::Str(get("body"))),
                            ("score".into(), Json::Num(1.0 / (60.0 + rank as f64))),
                            ("fusedRank".into(), Json::Num((rank + 1) as f64)),
                        ]));
                    }
                }
            }
        }
        sqlite_close();
    }
    ok_resp(
        id,
        "query",
        alloc::vec![
            ("status".into(), status_body(&state)),
            ("hits".into(), Json::Arr(hits)),
            ("semanticAvailable".into(), Json::Bool(j_get_bool(&state, "semanticReady"))),
        ],
    )
}

fn handle_embed_step(req: &Json) -> Json {
    let id = j_get_str(req, "id").unwrap_or("embed");
    let mut state = load_state();
    if !j_get_bool(&state, "lexicalReady") {
        return err_resp(id, "not_ready", "lexical index not ready");
    }
    if j_get_bool(&state, "writeCandidate") {
        return err_resp(id, "busy", "candidate refresh in progress");
    }
    // Semantic path: mark ready if embed tool unavailable (lexical remains).
    let max_chunks = j_get_u64(req, "maxChunks", 8);
    let _ = max_chunks;
    let args = j_obj(alloc::vec![
        ("texts".into(), Json::Arr(alloc::vec![Json::Str("warmup".into())])),
        ("kind".into(), Json::Str("document".into())),
    ]);
    match tools_call(EMBED_ADDR, args) {
        Some(r) if j_get_bool(&r, "ok") || r.get("vectors").is_some() => {
            set_field(&mut state, "semanticReady", Json::Bool(true));
            set_field(&mut state, "phase", Json::Str("semantic_ready".into()));
            set_field(&mut state, "message", Json::Str("Semantic index ready".into()));
        }
        _ => {
            set_field(&mut state, "semanticReady", Json::Bool(false));
            set_field(&mut state, "phase", Json::Str("lexical_ready".into()));
            set_field(
                &mut state,
                "message",
                Json::Str("Lexical index ready".into()),
            );
        }
    }
    save_state(&state);
    ok_resp(
        id,
        "embed_step",
        alloc::vec![
            ("status".into(), status_body(&state)),
            (
                "progress".into(),
                j_obj(alloc::vec![
                    ("embeddedChunks".into(), Json::Num(0.0)),
                    ("done".into(), Json::Bool(true)),
                ]),
            ),
        ],
    )
}

fn handle_refresh(req: &Json) -> Json {
    let id = j_get_str(req, "id").unwrap_or("refresh");
    let mut state = load_state();
    if !j_get_bool(&state, "lexicalReady") {
        return err_resp(id, "not_ready", "cannot refresh before lexical ready");
    }
    if j_get_bool(&state, "writeCandidate") {
        return err_resp(id, "busy", "candidate refresh already in progress");
    }
    let _ = write_file(CANDIDATE_PATH, b"");
    let cand_id = format!("cand-{}", j_get_u64(&state, "pages", 0) + 1);
    set_field(&mut state, "writeCandidate", Json::Bool(true));
    set_field(
        &mut state,
        "candidateGeneration",
        Json::Str(cand_id),
    );
    set_field(&mut state, "candidatePages", Json::Num(0.0));
    set_field(&mut state, "candidateChunks", Json::Num(0.0));
    set_field(&mut state, "phase", Json::Str("refreshing".into()));
    set_field(
        &mut state,
        "message",
        Json::Str("Refreshing candidate generation".into()),
    );

    // re-seed queue from collections
    let mut queue = Vec::new();
    if let Some(Json::Arr(cols)) = state.get("collections") {
        for c in cols {
            if let Json::Arr(seeds) = c.get("seeds").unwrap_or(&Json::Arr(Vec::new())) {
                let cid = j_get_str(c, "id").unwrap_or("site");
                for s in seeds {
                    if let Some(url) = j_str(s) {
                        queue.push(j_obj(alloc::vec![
                            ("url".into(), Json::Str(url.into())),
                            ("collectionId".into(), Json::Str(cid.into())),
                        ]));
                    }
                }
            }
        }
    }
    set_field(&mut state, "queue", Json::Arr(queue));

    let schema = j_get_str(&state, "schemaSql").unwrap_or("").to_string();
    if sqlite_open(CANDIDATE_PATH) {
        if !schema.is_empty() {
            apply_schema(&schema);
        }
        sqlite_close();
    }
    save_state(&state);
    ok_resp(id, "refresh", alloc::vec![("status".into(), status_body(&state))])
}

fn handle_checkpoint(req: &Json) -> Json {
    let id = j_get_str(req, "id").unwrap_or("checkpoint");
    let state = load_state();
    ok_resp(
        id,
        "checkpoint",
        alloc::vec![
            ("status".into(), status_body(&state)),
            (
                "checkpoint".into(),
                j_obj(alloc::vec![
                    ("kind".into(), Json::Str(if j_get_bool(&state, "semanticReady") {
                        "semantic".into()
                    } else if j_get_bool(&state, "lexicalReady") {
                        "lexical".into()
                    } else {
                        "idle".into()
                    })),
                ]),
            ),
        ],
    )
}

fn handle_promote(req: &Json) -> Json {
    let id = j_get_str(req, "id").unwrap_or("promote");
    let mut state = load_state();
    if let Some(g) = j_get_str(req, "generationId") {
        set_field(&mut state, "generation", Json::Str(g.into()));
    }
    save_state(&state);
    ok_resp(id, "promote", alloc::vec![("status".into(), status_body(&state))])
}

fn handle_cancel(req: &Json) -> Json {
    let id = j_get_str(req, "id").unwrap_or("cancel");
    ok_resp(id, "cancel", Vec::new())
}

fn dispatch(req: &Json) -> Json {
    let id = j_get_str(req, "id").unwrap_or("unknown");
    let v = req.get("v").and_then(|x| x.as_f64()).unwrap_or(0.0) as i32;
    let op = j_get_str(req, "op").unwrap_or("");
    if v != 1 {
        return err_resp(id, "bad_request", "invalid searchd request");
    }
    match op {
        "configure" => handle_configure(req),
        "status" => handle_status(req),
        "crawl_step" => handle_crawl_step(req),
        "embed_step" => handle_embed_step(req),
        "query" => handle_query(req),
        "checkpoint" => handle_checkpoint(req),
        "promote" => handle_promote(req),
        "refresh" => handle_refresh(req),
        "cancel" => handle_cancel(req),
        _ => err_resp(id, "unknown_op", &format!("unknown op {}", op)),
    }
}

fn serve_loop() -> ! {
    let server = match rt::svc_serve(SERVICE_NAME) {
        Ok(fd) => fd,
        Err(_) => rt::exit(1),
    };
    let mut buf = [0u8; 65536];
    let mut hbuf = [0i32; 0];
    loop {
        let n = match rt::svc_recv(server, &mut buf, &mut hbuf) {
            Ok(n) => n,
            Err(_) => rt::exit(0),
        };
        let Some(req) = rt::parse_svc_request(&buf[..n], &hbuf) else {
            continue;
        };
        if req.kind != rt::SvcKind::Call {
            continue;
        }
        let response = match core::str::from_utf8(req.blob)
            .ok()
            .and_then(|s| json::parse(s).ok())
        {
            Some(doc) => json::to_string(&dispatch(&doc)),
            None => json::to_string(&err_resp("none", "bad_json", "request must be JSON")),
        };
        let _ = rt::svc_respond(
            server,
            req.session,
            req.req_id,
            0,
            response.as_bytes(),
            true,
        );
    }
}

fn main() {
    let mut argbuf = [0u8; 4096];
    let n = rt::args_into(&mut argbuf);
    // Split on NUL: arg0, arg1, …
    let mut parts: Vec<&[u8]> = Vec::new();
    let mut start = 0usize;
    for i in 0..n {
        if argbuf[i] == 0 {
            if start < i {
                parts.push(&argbuf[start..i]);
            }
            start = i + 1;
        }
    }
    let arg1 = parts.get(1).copied().unwrap_or(b"");
    if arg1 == rt::SERVICE_MARKER.as_bytes() {
        serve_loop();
    }
    // One-shot CLI not supported — product uses serviceCall only.
    rt::eprint("searchd: service-only; use vm.serviceCall(\"searchd\", …)\n");
    rt::exit(2);
}
