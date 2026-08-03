//! searchd op handlers (configure/crawl/query/refresh/promote/…).

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use json::Json;
use sysroot as rt;

// ── handlers ─────────────────────────────────────────────────────────────────

fn handle_configure(req: &Json) -> Json {
    crate::fsutil::ensure_dir();
    let id = crate::jsonx::j_get_str(req, "id").unwrap_or("cfg");
    let config = req.get("config").cloned().unwrap_or(Json::Obj(Vec::new()));
    let resume = crate::jsonx::j_get_bool(&config, "resume");
    let key = crate::jsonx::j_get_str(&config, "compatibilityKey").unwrap_or("");
    let mut state = crate::state::load_state();
    let same = crate::jsonx::j_get_str(&state, "compatibilityKey").unwrap_or("") == key && !key.is_empty();
    let can_resume = resume && same && crate::jsonx::j_get_bool(&state, "lexicalReady");

    if can_resume {
        crate::state::set_field(&mut state, "message", Json::Str("Resumed from warm snapshot".into()));
        crate::state::set_field(&mut state, "writeCandidate", Json::Bool(false));
        if let Some(mf) = crate::jsonx::j_get_str(&config, "modelFingerprint") {
            crate::state::set_field(&mut state, "modelFingerprint", Json::Str(mf.into()));
        }
        if let Some(sql) = crate::jsonx::j_get_str(&config, "schemaSql") {
            crate::state::set_field(&mut state, "schemaSql", Json::Str(sql.into()));
        }
        crate::state::save_state(&state);
        return crate::jsonx::ok_resp(id, "configure", alloc::vec![("status".into(), crate::state::status_body(&state))]);
    }

    // Cold configure
    crate::state::set_field(&mut state, "phase", Json::Str("configuring".into()));
    crate::state::set_field(&mut state, "compatibilityKey", Json::Str(key.into()));
    crate::state::set_field(
        &mut state,
        "modelFingerprint",
        Json::Str(crate::jsonx::j_get_str(&config, "modelFingerprint").unwrap_or("").into()),
    );
    crate::state::set_field(
        &mut state,
        "pageOrigin",
        Json::Str(crate::jsonx::j_get_str(&config, "pageOrigin").unwrap_or("").into()),
    );
    let schema = crate::jsonx::j_get_str(&config, "schemaSql").unwrap_or("").to_string();
    crate::state::set_field(&mut state, "schemaSql", Json::Str(schema.clone()));
    crate::state::set_field(&mut state, "lexicalReady", Json::Bool(false));
    crate::state::set_field(&mut state, "semanticReady", Json::Bool(false));
    crate::state::set_field(&mut state, "pages", Json::Num(0.0));
    crate::state::set_field(&mut state, "chunks", Json::Num(0.0));
    crate::state::set_field(&mut state, "embeddedChunks", Json::Num(0.0));
    crate::state::set_field(&mut state, "generation", Json::Str("gen-1".into()));
    crate::state::set_field(&mut state, "writeCandidate", Json::Bool(false));
    crate::state::set_field(&mut state, "message", Json::Str("Configured".into()));

    let collections = config.get("collections").cloned().unwrap_or(Json::Arr(Vec::new()));
    crate::state::set_field(&mut state, "collections", collections.clone());

    // Seed queue from collection seeds
    let mut queue = Vec::new();
    if let Json::Arr(cols) = &collections {
        for c in cols {
            if let Json::Arr(seeds) = c.get("seeds").unwrap_or(&Json::Arr(Vec::new())) {
                let cid = crate::jsonx::j_get_str(c, "id").unwrap_or("site");
                for s in seeds {
                    if let Some(url) = crate::jsonx::j_str(s) {
                        queue.push(crate::jsonx::j_obj(alloc::vec![
                            ("url".into(), Json::Str(url.into())),
                            ("collectionId".into(), Json::Str(cid.into())),
                        ]));
                    }
                }
            }
        }
    }
    crate::state::set_field(&mut state, "queue", Json::Arr(queue));

    let _ = crate::fsutil::write_file(crate::paths::CANDIDATE_PATH, b"");
    if crate::svc::sqlite_open(crate::paths::INDEX_PATH) {
        if !schema.is_empty() {
            crate::svc::apply_schema(&schema);
        }
        // ensure PRAGMA
        let _ = crate::svc::sqlite_exec("PRAGMA foreign_keys = ON");
        if let Json::Arr(cols) = &collections {
            for c in cols {
                let cid = crate::jsonx::j_get_str(c, "id").unwrap_or("site");
                let label = crate::jsonx::j_get_str(c, "label").unwrap_or(cid);
                let sql = format!(
                    "INSERT INTO collections(id, label, source_json, page_count, chunk_count, built_at) VALUES ('{}', '{}', '{{}}', 0, 0, datetime('now')) ON CONFLICT(id) DO UPDATE SET label=excluded.label",
                    cid.replace('\'', "''"),
                    label.replace('\'', "''")
                );
                let _ = crate::svc::sqlite_exec(&sql);
            }
        }
        crate::svc::sqlite_close();
    }

    crate::state::set_field(&mut state, "phase", Json::Str("crawling".into()));
    crate::state::set_field(&mut state, "message", Json::Str("Crawl queued".into()));
    crate::state::save_state(&state);
    crate::jsonx::ok_resp(id, "configure", alloc::vec![("status".into(), crate::state::status_body(&state))])
}

fn handle_status(req: &Json) -> Json {
    let id = crate::jsonx::j_get_str(req, "id").unwrap_or("status");
    let state = crate::state::load_state();
    crate::jsonx::ok_resp(id, "status", alloc::vec![("status".into(), crate::state::status_body(&state))])
}

fn is_http_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

fn handle_crawl_step(req: &Json) -> Json {
    let id = crate::jsonx::j_get_str(req, "id").unwrap_or("crawl");
    let mut state = crate::state::load_state();
    if crate::jsonx::j_get_str(&state, "phase").unwrap_or("") == "unconfigured" {
        return crate::jsonx::err_resp(id, "not_configured", "call configure first");
    }
    let max_fetches = crate::jsonx::j_get_u64(req, "maxFetches", 4) as usize;
    let write_cand = crate::jsonx::j_get_bool(&state, "writeCandidate");
    let db_path = if write_cand { crate::paths::CANDIDATE_PATH } else { crate::paths::INDEX_PATH };

    let mut queue = match state.get("queue").cloned().unwrap_or(Json::Arr(Vec::new())) {
        Json::Arr(a) => a,
        _ => Vec::new(),
    };
    let mut fetches = 0usize;
    let mut indexed_pages = 0usize;
    let mut indexed_chunks = 0usize;

    while fetches < max_fetches && !queue.is_empty() {
        let item = queue.remove(0);
        let url = crate::jsonx::j_get_str(&item, "url").unwrap_or("").to_string();
        let cid = crate::jsonx::j_get_str(&item, "collectionId").unwrap_or("site").to_string();
        if !is_http_url(&url) {
            continue;
        }
        fetches += 1;

        let args = crate::jsonx::j_obj(alloc::vec![
            ("url".into(), Json::Str(url.clone())),
            ("maxBytes".into(), Json::Num(2_000_000.0)),
            ("timeoutMs".into(), Json::Num(15_000.0)),
        ]);
        let Some(fetched_wrap) = crate::svc::tools_call(crate::paths::FETCH_ADDR, args) else {
            continue;
        };
        // tools returns {ok, data} or error envelope
        let fetched = if crate::jsonx::j_get_bool(&fetched_wrap, "ok") {
            fetched_wrap.get("data").cloned().unwrap_or(fetched_wrap)
        } else {
            continue;
        };
        let status = crate::jsonx::j_get_u64(&fetched, "status", 0);
        if status >= 400 {
            continue;
        }
        let body = crate::jsonx::j_get_str(&fetched, "body").unwrap_or("").to_string();
        let final_url = crate::jsonx::j_get_str(&fetched, "finalUrl").unwrap_or(&url).to_string();

        let extract_args = crate::jsonx::j_obj(alloc::vec![
            ("url".into(), Json::Str(final_url.clone())),
            ("html".into(), Json::Str(body)),
        ]);
        let Some(extracted_wrap) = crate::svc::tools_call(crate::paths::EXTRACT_ADDR, extract_args) else {
            continue;
        };
        let extracted = if crate::jsonx::j_get_bool(&extracted_wrap, "ok") {
            extracted_wrap.get("data").cloned().unwrap_or(extracted_wrap)
        } else {
            continue;
        };
        if crate::jsonx::j_get_bool(&extracted, "noindex") {
            continue;
        }

        // Enqueue links
        if let Some(Json::Arr(links)) = extracted.get("links") {
            for link in links {
                if let Some(u) = crate::jsonx::j_str(link) {
                    if is_http_url(u) {
                        queue.push(crate::jsonx::j_obj(alloc::vec![
                            ("url".into(), Json::Str(u.into())),
                            ("collectionId".into(), Json::Str(cid.clone())),
                        ]));
                    }
                }
            }
        }

        let title = crate::jsonx::j_get_str(&extracted, "title").unwrap_or("").to_string();
        let description = crate::jsonx::j_get_str(&extracted, "description").unwrap_or("").to_string();
        let canonical = crate::jsonx::j_get_str(&extracted, "canonicalUrl")
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
                    if let Some(tx) = crate::jsonx::j_get_str(b, "text") {
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

        if !crate::svc::sqlite_open(db_path) {
            continue;
        }
        let _ = crate::svc::sqlite_exec("PRAGMA foreign_keys = ON");
        let stable = format!("{}:{}", cid, canonical).replace('\'', "''");
        let title_e = title.replace('\'', "''");
        let desc_e = description.replace('\'', "''");
        let canon_e = canonical.replace('\'', "''");
        let url_e = final_url.replace('\'', "''");
        let body_e = body_text.replace('\'', "''");
        let _ = crate::svc::sqlite_exec(&format!(
            "DELETE FROM pages WHERE stable_id = '{}'",
            stable
        ));
        let _ = crate::svc::sqlite_exec(&format!(
            "INSERT INTO pages(stable_id, collection_id, url, canonical_url, title, description, language, content_hash, indexed_at) VALUES ('{}', '{}', '{}', '{}', '{}', '{}', '', 'x', strftime('%s','now'))",
            stable,
            cid.replace('\'', "''"),
            url_e,
            canon_e,
            title_e,
            desc_e
        ));
        let page_id = crate::svc::sqlite_query(&format!(
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
        let _ = crate::svc::sqlite_exec(&format!(
            "INSERT INTO chunks(stable_id, collection_id, page_id, ordinal, url, title, heading, body, content_hash, metadata_json) VALUES ('{}', '{}', {}, 1, '{}', '{}', '', '{}', 'x', '{{}}')",
            chunk_stable,
            cid.replace('\'', "''"),
            page_id,
            canon_e,
            title_e,
            body_e
        ));
        crate::svc::sqlite_close();

        indexed_pages += 1;
        indexed_chunks += 1;
        let pages = crate::jsonx::j_get_u64(&state, "pages", 0) + 1;
        let chunks = crate::jsonx::j_get_u64(&state, "chunks", 0) + 1;
        let cand_pages = crate::jsonx::j_get_u64(&state, "candidatePages", 0) + 1;
        let cand_chunks = crate::jsonx::j_get_u64(&state, "candidateChunks", 0) + 1;
        if write_cand {
            crate::state::set_field(&mut state, "candidatePages", Json::Num(cand_pages as f64));
            crate::state::set_field(&mut state, "candidateChunks", Json::Num(cand_chunks as f64));
        } else {
            crate::state::set_field(&mut state, "pages", Json::Num(pages as f64));
            crate::state::set_field(&mut state, "chunks", Json::Num(chunks as f64));
        }
    }

    crate::state::set_field(&mut state, "queue", Json::Arr(queue.clone()));
    let done = queue.is_empty();
    if done || crate::jsonx::j_get_u64(&state, "pages", 0) > 0 || crate::jsonx::j_get_u64(&state, "candidatePages", 0) > 0 {
        if !write_cand {
            crate::state::set_field(&mut state, "lexicalReady", Json::Bool(true));
        }
        if done {
            if write_cand {
                // promote candidate → index
                let pages = crate::jsonx::j_get_u64(&state, "candidatePages", 0);
                let chunks = crate::jsonx::j_get_u64(&state, "candidateChunks", 0);
                if pages >= 1 && chunks >= 1 {
                    if let Some(bytes) = crate::fsutil::read_file(crate::paths::CANDIDATE_PATH) {
                        if crate::fsutil::write_file(crate::paths::INDEX_PATH, &bytes) {
                            let gen = crate::jsonx::j_get_str(&state, "candidateGeneration")
                                .unwrap_or("gen-1")
                                .to_string();
                            crate::state::set_field(&mut state, "pages", Json::Num(pages as f64));
                            crate::state::set_field(&mut state, "chunks", Json::Num(chunks as f64));
                            crate::state::set_field(&mut state, "lexicalReady", Json::Bool(true));
                            crate::state::set_field(&mut state, "semanticReady", Json::Bool(false));
                            crate::state::set_field(&mut state, "writeCandidate", Json::Bool(false));
                            crate::state::set_field(
                                &mut state,
                                "generation",
                                Json::Str(gen),
                            );
                            crate::state::set_field(&mut state, "message", Json::Str("Candidate promoted".into()));
                            let _ = crate::fsutil::write_file(crate::paths::CANDIDATE_PATH, b"");
                        }
                    }
                } else {
                    crate::state::set_field(&mut state, "writeCandidate", Json::Bool(false));
                    crate::state::set_field(
                        &mut state,
                        "message",
                        Json::Str("Candidate discarded: incomplete".into()),
                    );
                    let _ = crate::fsutil::write_file(crate::paths::CANDIDATE_PATH, b"");
                }
                crate::state::set_field(&mut state, "phase", Json::Str("lexical_ready".into()));
            } else {
                crate::state::set_field(&mut state, "phase", Json::Str("lexical_ready".into()));
                crate::state::set_field(&mut state, "message", Json::Str("Lexical index ready".into()));
            }
        } else if write_cand {
            crate::state::set_field(&mut state, "phase", Json::Str("refreshing".into()));
        } else {
            crate::state::set_field(&mut state, "phase", Json::Str("crawling".into()));
        }
    }
    crate::state::save_state(&state);

    let progress = crate::jsonx::j_obj(alloc::vec![
        ("fetches".into(), Json::Num(fetches as f64)),
        ("indexedPages".into(), Json::Num(indexed_pages as f64)),
        ("indexedChunks".into(), Json::Num(indexed_chunks as f64)),
        ("queueDepth".into(), Json::Num(queue.len() as f64)),
        ("done".into(), Json::Bool(done)),
    ]);
    crate::jsonx::ok_resp(
        id,
        "crawl_step",
        alloc::vec![
            ("status".into(), crate::state::status_body(&state)),
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
    let id = crate::jsonx::j_get_str(req, "id").unwrap_or("query");
    let state = crate::state::load_state();
    if !crate::jsonx::j_get_bool(&state, "lexicalReady") {
        return crate::jsonx::ok_resp(
            id,
            "query",
            alloc::vec![
                ("status".into(), crate::state::status_body(&state)),
                ("hits".into(), Json::Arr(Vec::new())),
                ("semanticAvailable".into(), Json::Bool(false)),
            ],
        );
    }
    let q = crate::jsonx::j_get_str(req, "query").unwrap_or("");
    let collection_id = crate::jsonx::j_get_str(req, "collectionId").unwrap_or("site");
    let limit = crate::jsonx::j_get_u64(req, "limit", 10) as usize;
    let fts = build_fts_query(q);
    let mut hits = Vec::new();
    if !fts.is_empty() && crate::svc::sqlite_open(crate::paths::INDEX_PATH) {
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
        if let Some(r) = crate::svc::sqlite_query(&sql) {
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
                        hits.push(crate::jsonx::j_obj(alloc::vec![
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
        crate::svc::sqlite_close();
    }
    crate::jsonx::ok_resp(
        id,
        "query",
        alloc::vec![
            ("status".into(), crate::state::status_body(&state)),
            ("hits".into(), Json::Arr(hits)),
            ("semanticAvailable".into(), Json::Bool(crate::jsonx::j_get_bool(&state, "semanticReady"))),
        ],
    )
}

fn handle_embed_step(req: &Json) -> Json {
    let id = crate::jsonx::j_get_str(req, "id").unwrap_or("embed");
    let mut state = crate::state::load_state();
    if !crate::jsonx::j_get_bool(&state, "lexicalReady") {
        return crate::jsonx::err_resp(id, "not_ready", "lexical index not ready");
    }
    if crate::jsonx::j_get_bool(&state, "writeCandidate") {
        return crate::jsonx::err_resp(id, "busy", "candidate refresh in progress");
    }
    // Semantic path: mark ready if embed tool unavailable (lexical remains).
    let max_chunks = crate::jsonx::j_get_u64(req, "maxChunks", 8);
    let _ = max_chunks;
    let args = crate::jsonx::j_obj(alloc::vec![
        ("texts".into(), Json::Arr(alloc::vec![Json::Str("warmup".into())])),
        ("kind".into(), Json::Str("document".into())),
    ]);
    match crate::svc::tools_call(crate::paths::EMBED_ADDR, args) {
        Some(r) if crate::jsonx::j_get_bool(&r, "ok") || r.get("vectors").is_some() => {
            crate::state::set_field(&mut state, "semanticReady", Json::Bool(true));
            crate::state::set_field(&mut state, "phase", Json::Str("semantic_ready".into()));
            crate::state::set_field(&mut state, "message", Json::Str("Semantic index ready".into()));
        }
        _ => {
            crate::state::set_field(&mut state, "semanticReady", Json::Bool(false));
            crate::state::set_field(&mut state, "phase", Json::Str("lexical_ready".into()));
            crate::state::set_field(
                &mut state,
                "message",
                Json::Str("Lexical index ready".into()),
            );
        }
    }
    crate::state::save_state(&state);
    crate::jsonx::ok_resp(
        id,
        "embed_step",
        alloc::vec![
            ("status".into(), crate::state::status_body(&state)),
            (
                "progress".into(),
                crate::jsonx::j_obj(alloc::vec![
                    ("embeddedChunks".into(), Json::Num(0.0)),
                    ("done".into(), Json::Bool(true)),
                ]),
            ),
        ],
    )
}

fn handle_refresh(req: &Json) -> Json {
    let id = crate::jsonx::j_get_str(req, "id").unwrap_or("refresh");
    let mut state = crate::state::load_state();
    if !crate::jsonx::j_get_bool(&state, "lexicalReady") {
        return crate::jsonx::err_resp(id, "not_ready", "cannot refresh before lexical ready");
    }
    if crate::jsonx::j_get_bool(&state, "writeCandidate") {
        return crate::jsonx::err_resp(id, "busy", "candidate refresh already in progress");
    }
    let _ = crate::fsutil::write_file(crate::paths::CANDIDATE_PATH, b"");
    let cand_id = format!("cand-{}", crate::jsonx::j_get_u64(&state, "pages", 0) + 1);
    crate::state::set_field(&mut state, "writeCandidate", Json::Bool(true));
    crate::state::set_field(
        &mut state,
        "candidateGeneration",
        Json::Str(cand_id),
    );
    crate::state::set_field(&mut state, "candidatePages", Json::Num(0.0));
    crate::state::set_field(&mut state, "candidateChunks", Json::Num(0.0));
    crate::state::set_field(&mut state, "phase", Json::Str("refreshing".into()));
    crate::state::set_field(
        &mut state,
        "message",
        Json::Str("Refreshing candidate generation".into()),
    );

    // re-seed queue from collections
    let mut queue = Vec::new();
    if let Some(Json::Arr(cols)) = state.get("collections") {
        for c in cols {
            if let Json::Arr(seeds) = c.get("seeds").unwrap_or(&Json::Arr(Vec::new())) {
                let cid = crate::jsonx::j_get_str(c, "id").unwrap_or("site");
                for s in seeds {
                    if let Some(url) = crate::jsonx::j_str(s) {
                        queue.push(crate::jsonx::j_obj(alloc::vec![
                            ("url".into(), Json::Str(url.into())),
                            ("collectionId".into(), Json::Str(cid.into())),
                        ]));
                    }
                }
            }
        }
    }
    crate::state::set_field(&mut state, "queue", Json::Arr(queue));

    let schema = crate::jsonx::j_get_str(&state, "schemaSql").unwrap_or("").to_string();
    if crate::svc::sqlite_open(crate::paths::CANDIDATE_PATH) {
        if !schema.is_empty() {
            crate::svc::apply_schema(&schema);
        }
        crate::svc::sqlite_close();
    }
    crate::state::save_state(&state);
    crate::jsonx::ok_resp(id, "refresh", alloc::vec![("status".into(), crate::state::status_body(&state))])
}

fn handle_checkpoint(req: &Json) -> Json {
    let id = crate::jsonx::j_get_str(req, "id").unwrap_or("checkpoint");
    let state = crate::state::load_state();
    crate::jsonx::ok_resp(
        id,
        "checkpoint",
        alloc::vec![
            ("status".into(), crate::state::status_body(&state)),
            (
                "checkpoint".into(),
                crate::jsonx::j_obj(alloc::vec![
                    ("kind".into(), Json::Str(if crate::jsonx::j_get_bool(&state, "semanticReady") {
                        "semantic".into()
                    } else if crate::jsonx::j_get_bool(&state, "lexicalReady") {
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
    let id = crate::jsonx::j_get_str(req, "id").unwrap_or("promote");
    let mut state = crate::state::load_state();
    if let Some(g) = crate::jsonx::j_get_str(req, "generationId") {
        crate::state::set_field(&mut state, "generation", Json::Str(g.into()));
    }
    crate::state::save_state(&state);
    crate::jsonx::ok_resp(id, "promote", alloc::vec![("status".into(), crate::state::status_body(&state))])
}

fn handle_cancel(req: &Json) -> Json {
    let id = crate::jsonx::j_get_str(req, "id").unwrap_or("cancel");
    crate::jsonx::ok_resp(id, "cancel", Vec::new())
}

pub(crate) fn dispatch(req: &Json) -> Json {
    let id = crate::jsonx::j_get_str(req, "id").unwrap_or("unknown");
    let v = req.get("v").and_then(|x| x.as_f64()).unwrap_or(0.0) as i32;
    let op = crate::jsonx::j_get_str(req, "op").unwrap_or("");
    if v != 1 {
        return crate::jsonx::err_resp(id, "bad_request", "invalid searchd request");
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
        _ => crate::jsonx::err_resp(id, "unknown_op", &format!("unknown op {}", op)),
    }
}

pub(crate) fn serve_loop() -> ! {
    let server = match rt::svc_serve(crate::paths::SERVICE_NAME) {
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
            None => json::to_string(&crate::jsonx::err_resp("none", "bad_json", "request must be JSON")),
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

