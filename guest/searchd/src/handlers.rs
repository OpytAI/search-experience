//! searchd op handlers (configure/crawl/query/refresh/promote/…).

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use json::Json;
use sysroot as rt;

use crate::crawl_policy;
use crate::sql_safe;

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
    crate::state::set_field(&mut state, "visited", Json::Arr(Vec::new()));
    crate::state::set_field(&mut state, "robots", Json::Obj(Vec::new()));
    crate::state::set_field(&mut state, "sitemapSeeded", Json::Arr(Vec::new()));
    crate::state::set_field(&mut state, "pagesByCollection", Json::Obj(Vec::new()));

    let collections = config.get("collections").cloned().unwrap_or(Json::Arr(Vec::new()));
    crate::state::set_field(&mut state, "collections", collections.clone());

    // Seed queue from collection seeds that pass path policy
    let mut queue = Vec::new();
    if let Json::Arr(cols) = &collections {
        for c in cols {
            let cid = crate::jsonx::j_get_str(c, "id").unwrap_or("site");
            let inc = crawl_policy::collection_includes(c);
            let exc = crawl_policy::collection_excludes(c);
            if let Json::Arr(seeds) = c.get("seeds").unwrap_or(&Json::Arr(Vec::new())) {
                for s in seeds {
                    if let Some(url) = crate::jsonx::j_str(s) {
                        if !is_http_url(url) {
                            continue;
                        }
                        if let Some(path) = crawl_policy::url_pathname(url) {
                            if !crawl_policy::path_allowed(&path, &inc, &exc) {
                                continue;
                            }
                        } else {
                            continue;
                        }
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
        let _ = crate::svc::sqlite_exec("PRAGMA foreign_keys = ON");
        if let Json::Arr(cols) = &collections {
            for c in cols {
                let cid = crate::jsonx::j_get_str(c, "id").unwrap_or("site");
                let label = crate::jsonx::j_get_str(c, "label").unwrap_or(cid);
                let sql = format!(
                    "INSERT INTO collections(id, label, source_json, page_count, chunk_count, built_at) VALUES ({}, {}, '{{}}', 0, 0, datetime('now')) ON CONFLICT(id) DO UPDATE SET label=excluded.label",
                    sql_safe::sql_quote_string(cid),
                    sql_safe::sql_quote_string(label),
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

/// Fetch robots.txt for an origin once; cache in state. Transport failure → deny-by-default.
fn ensure_robots(state: &mut Json, origin: &str) -> crawl_policy::RobotsPolicy {
    if let Some(p) = crawl_policy::robots_cached(state, origin) {
        return p;
    }
    let robots_url = format!("{}/robots.txt", origin.trim_end_matches('/'));
    let args = crate::jsonx::j_obj(alloc::vec![
        ("url".into(), Json::Str(robots_url)),
        ("maxBytes".into(), Json::Num(256_000.0)),
        ("timeoutMs".into(), Json::Num(10_000.0)),
    ]);
    let policy = match crate::svc::tools_call(crate::paths::FETCH_ADDR, args) {
        Some(wrap) => {
            let fetched = if crate::jsonx::j_get_bool(&wrap, "ok") {
                wrap.get("data").cloned().unwrap_or(wrap)
            } else {
                crawl_policy::robots_store(state, origin, &crawl_policy::RobotsPolicy::deny());
                return crawl_policy::RobotsPolicy::deny();
            };
            let status = crate::jsonx::j_get_u64(&fetched, "status", 0);
            if status == 404 || status == 410 {
                crawl_policy::RobotsPolicy::empty_allow()
            } else if status >= 200 && status < 300 {
                let body = crate::jsonx::j_get_str(&fetched, "body").unwrap_or("");
                crawl_policy::parse_robots_txt(body)
            } else if status == 0 {
                // Transport / tool failure
                crawl_policy::RobotsPolicy::deny()
            } else {
                // 5xx / other → deny-by-default for this generation
                crawl_policy::RobotsPolicy::deny()
            }
        }
        None => crawl_policy::RobotsPolicy::deny(),
    };
    crawl_policy::robots_store(state, origin, &policy);
    policy
}

/// Optionally seed queue from sitemap.xml (+ robots Sitemap:) for an origin (bounded).
fn maybe_seed_sitemap(
    state: &mut Json,
    origin: &str,
    collection_id: &str,
    col: &Json,
    queue: &mut Vec<Json>,
) {
    if crawl_policy::sitemap_seeded(state, origin) {
        return;
    }
    crawl_policy::mark_sitemap_seeded(state, origin);
    let max_sitemaps = crawl_policy::collection_max_sitemaps(col) as usize;
    if max_sitemaps == 0 {
        return;
    }
    let max_queue = crawl_policy::collection_max_queue(col) as usize;
    let inc = crawl_policy::collection_includes(col);
    let exc = crawl_policy::collection_excludes(col);
    let policy = ensure_robots(state, origin);

    let mut candidates: Vec<String> = Vec::new();
    for s in &policy.sitemaps {
        candidates.push(s.clone());
    }
    candidates.push(format!("{}/sitemap.xml", origin.trim_end_matches('/')));

    let mut fetched = 0usize;
    let mut i = 0usize;
    while i < candidates.len() && fetched < max_sitemaps {
        let sm_url = candidates[i].clone();
        i += 1;
        if !is_http_url(&sm_url) {
            continue;
        }
        // Same origin only for sitemap fetches
        if crawl_policy::url_origin(&sm_url).as_deref() != Some(origin) {
            continue;
        }
        fetched += 1;
        let args = crate::jsonx::j_obj(alloc::vec![
            ("url".into(), Json::Str(sm_url)),
            ("maxBytes".into(), Json::Num(2_000_000.0)),
            ("timeoutMs".into(), Json::Num(15_000.0)),
        ]);
        let Some(wrap) = crate::svc::tools_call(crate::paths::FETCH_ADDR, args) else {
            continue;
        };
        let fetched_body = if crate::jsonx::j_get_bool(&wrap, "ok") {
            wrap.get("data").cloned().unwrap_or(wrap)
        } else {
            continue;
        };
        let status = crate::jsonx::j_get_u64(&fetched_body, "status", 0);
        if status < 200 || status >= 300 {
            continue;
        }
        let body = crate::jsonx::j_get_str(&fetched_body, "body").unwrap_or("");
        let locs = crawl_policy::sitemap_locations(body, 500);
        let is_index = body.to_ascii_lowercase().contains("<sitemapindex");
        for loc in locs {
            if is_index {
                if candidates.len() < max_sitemaps + 5
                    && crawl_policy::url_origin(&loc).as_deref() == Some(origin)
                {
                    candidates.push(loc);
                }
            } else {
                if queue.len() >= max_queue {
                    break;
                }
                if !is_http_url(&loc) {
                    continue;
                }
                if let Some(path) = crawl_policy::url_pathname(&loc) {
                    if !crawl_policy::path_allowed(&path, &inc, &exc) {
                        continue;
                    }
                } else {
                    continue;
                }
                if crawl_policy::is_visited(state, &loc) {
                    continue;
                }
                // Avoid duplicate queue entries
                let already = queue.iter().any(|q| {
                    crate::jsonx::j_get_str(q, "url") == Some(loc.as_str())
                        && crate::jsonx::j_get_str(q, "collectionId") == Some(collection_id)
                });
                if already {
                    continue;
                }
                queue.push(crate::jsonx::j_obj(alloc::vec![
                    ("url".into(), Json::Str(loc)),
                    ("collectionId".into(), Json::Str(collection_id.into())),
                ]));
            }
        }
    }
}

fn handle_crawl_step(req: &Json) -> Json {
    let id = crate::jsonx::j_get_str(req, "id").unwrap_or("crawl");
    let mut state = crate::state::load_state();
    if crate::jsonx::j_get_str(&state, "phase").unwrap_or("") == "unconfigured" {
        return crate::jsonx::err_resp(id, "not_configured", "call configure first");
    }
    let max_fetches = crate::jsonx::j_get_u64(req, "maxFetches", 4) as usize;
    let write_cand = crate::jsonx::j_get_bool(&state, "writeCandidate");
    let db_path = if write_cand {
        crate::paths::CANDIDATE_PATH
    } else {
        crate::paths::INDEX_PATH
    };

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
        let cid = crate::jsonx::j_get_str(&item, "collectionId")
            .unwrap_or("site")
            .to_string();
        if !is_http_url(&url) {
            continue;
        }
        if crawl_policy::is_visited(&state, &url) {
            continue;
        }

        // Per-collection maxPages
        let col = crawl_policy::find_collection(&state, &cid).cloned();
        let max_pages = col
            .as_ref()
            .map(crawl_policy::collection_max_pages)
            .unwrap_or(crawl_policy::DEFAULT_MAX_PAGES);
        let pages_here = crawl_policy::pages_for_collection(&state, &cid);
        if pages_here >= max_pages {
            // Drop remaining queue items for this collection
            queue.retain(|q| crate::jsonx::j_get_str(q, "collectionId") != Some(cid.as_str()));
            continue;
        }

        // Path policy
        if !crawl_policy::url_allowed_for_collection(&state, &cid, &url) {
            crawl_policy::mark_visited(&mut state, &url);
            continue;
        }

        let Some(origin) = crawl_policy::url_origin(&url) else {
            continue;
        };

        // Robots once per origin
        let robots = ensure_robots(&mut state, &origin);
        if !robots.allows_url(&url) {
            crawl_policy::mark_visited(&mut state, &url);
            continue;
        }

        // Sitemap seed (bounded) for this origin
        if let Some(ref c) = col {
            maybe_seed_sitemap(&mut state, &origin, &cid, c, &mut queue);
        }

        crawl_policy::mark_visited(&mut state, &url);
        fetches += 1;

        let args = crate::jsonx::j_obj(alloc::vec![
            ("url".into(), Json::Str(url.clone())),
            ("maxBytes".into(), Json::Num(2_000_000.0)),
            ("timeoutMs".into(), Json::Num(15_000.0)),
        ]);
        let Some(fetched_wrap) = crate::svc::tools_call(crate::paths::FETCH_ADDR, args) else {
            continue;
        };
        let fetched = if crate::jsonx::j_get_bool(&fetched_wrap, "ok") {
            fetched_wrap.get("data").cloned().unwrap_or(fetched_wrap)
        } else {
            continue;
        };
        let status = crate::jsonx::j_get_u64(&fetched, "status", 0);
        if status >= 400 {
            continue;
        }
        let body = crate::jsonx::j_get_str(&fetched, "body")
            .unwrap_or("")
            .to_string();
        let final_url = crate::jsonx::j_get_str(&fetched, "finalUrl")
            .unwrap_or(&url)
            .to_string();

        // Redirect may leave path policy
        if !crawl_policy::url_allowed_for_collection(&state, &cid, &final_url) {
            continue;
        }
        if let Some(fo) = crawl_policy::url_origin(&final_url) {
            if fo != origin {
                // Same-origin crawl only relative to robots origin; drop cross-origin redirects
                continue;
            }
        }

        let extract_args = crate::jsonx::j_obj(alloc::vec![
            ("url".into(), Json::Str(final_url.clone())),
            ("html".into(), Json::Str(body)),
        ]);
        let Some(extracted_wrap) = crate::svc::tools_call(crate::paths::EXTRACT_ADDR, extract_args)
        else {
            continue;
        };
        let extracted = if crate::jsonx::j_get_bool(&extracted_wrap, "ok") {
            extracted_wrap
                .get("data")
                .cloned()
                .unwrap_or(extracted_wrap)
        } else {
            continue;
        };
        if crate::jsonx::j_get_bool(&extracted, "noindex") {
            continue;
        }

        // Enqueue links that pass path policy and budgets
        let max_queue = col
            .as_ref()
            .map(crawl_policy::collection_max_queue)
            .unwrap_or(crawl_policy::DEFAULT_MAX_QUEUE) as usize;
        if let Some(Json::Arr(links)) = extracted.get("links") {
            for link in links {
                if queue.len() >= max_queue {
                    break;
                }
                if let Some(u) = crate::jsonx::j_str(link) {
                    if !is_http_url(u) {
                        continue;
                    }
                    if crawl_policy::is_visited(&state, u) {
                        continue;
                    }
                    if !crawl_policy::url_allowed_for_collection(&state, &cid, u) {
                        continue;
                    }
                    // Prefer same origin as pageOrigin / seed origin
                    if let (Some(lo), Some(po)) = (
                        crawl_policy::url_origin(u),
                        crawl_policy::url_origin(&final_url),
                    ) {
                        if lo != po {
                            continue;
                        }
                    }
                    let already = queue.iter().any(|q| {
                        crate::jsonx::j_get_str(q, "url") == Some(u)
                            && crate::jsonx::j_get_str(q, "collectionId") == Some(cid.as_str())
                    });
                    if already {
                        continue;
                    }
                    queue.push(crate::jsonx::j_obj(alloc::vec![
                        ("url".into(), Json::Str(u.into())),
                        ("collectionId".into(), Json::Str(cid.clone())),
                    ]));
                }
            }
        }

        // Re-check maxPages after possible concurrent counting
        let pages_here = crawl_policy::pages_for_collection(&state, &cid);
        if pages_here >= max_pages {
            continue;
        }

        let title = crate::jsonx::j_get_str(&extracted, "title")
            .unwrap_or("")
            .to_string();
        let description = crate::jsonx::j_get_str(&extracted, "description")
            .unwrap_or("")
            .to_string();
        let canonical = crate::jsonx::j_get_str(&extracted, "canonicalUrl")
            .unwrap_or(&final_url)
            .to_string();
        if !is_http_url(&canonical) {
            continue;
        }
        if !crawl_policy::url_allowed_for_collection(&state, &cid, &canonical) {
            continue;
        }

        // Index one page with a single chunk. Prefer description + substantial blocks first
        // so snippets/secondary lines are not dominated by short "eyebrow" labels; still
        // append short blocks so their tokens remain searchable.
        let body_text = {
            let mut long_parts: Vec<String> = Vec::new();
            let mut short_parts: Vec<String> = Vec::new();
            if !description.is_empty() {
                long_parts.push(description.clone());
            }
            if let Some(Json::Arr(blocks)) = extracted.get("blocks") {
                for b in blocks {
                    if let Some(tx) = crate::jsonx::j_get_str(b, "text") {
                        let t = tx.trim();
                        if t.is_empty() {
                            continue;
                        }
                        if t.chars().count() < 40 {
                            short_parts.push(t.to_string());
                        } else if !long_parts.iter().any(|p| p == t) {
                            long_parts.push(t.to_string());
                        }
                    }
                }
            }
            let mut parts = long_parts;
            for s in short_parts {
                if !parts.iter().any(|p| p == &s) {
                    parts.push(s);
                }
            }
            parts.join("\n")
        };
        if body_text.is_empty() && title.is_empty() {
            continue;
        }

        if !crate::svc::sqlite_open(db_path) {
            continue;
        }
        let _ = crate::svc::sqlite_exec("PRAGMA foreign_keys = ON");
        let stable = format!("{}:{}", cid, canonical);
        let sql_stable = sql_safe::sql_quote_string(&stable);
        let sql_cid = sql_safe::sql_quote_string(&cid);
        let sql_title = sql_safe::sql_quote_string(&title);
        let sql_desc = sql_safe::sql_quote_string(&description);
        let sql_canon = sql_safe::sql_quote_string(&canonical);
        let sql_url = sql_safe::sql_quote_string(&final_url);
        let sql_body = sql_safe::sql_quote_string(&body_text);
        let _ = crate::svc::sqlite_exec(&format!(
            "DELETE FROM pages WHERE stable_id = {}",
            sql_stable
        ));
        let _ = crate::svc::sqlite_exec(&format!(
            "INSERT INTO pages(stable_id, collection_id, url, canonical_url, title, description, language, content_hash, indexed_at) VALUES ({}, {}, {}, {}, {}, {}, '', 'x', strftime('%s','now'))",
            sql_stable, sql_cid, sql_url, sql_canon, sql_title, sql_desc
        ));
        let page_id = crate::svc::sqlite_query(&format!(
            "SELECT id FROM pages WHERE stable_id = {}",
            sql_stable
        ))
        .and_then(|r| {
            let rows = r.get("rows")?.as_arr()?;
            let row = rows.first()?.as_arr()?;
            row.first()?.as_f64().map(|n| n as i64)
        })
        .unwrap_or(0);
        let chunk_stable = format!("{}#1", stable);
        let sql_chunk_stable = sql_safe::sql_quote_string(&chunk_stable);
        let _ = crate::svc::sqlite_exec(&format!(
            "INSERT INTO chunks(stable_id, collection_id, page_id, ordinal, url, title, heading, body, content_hash, metadata_json) VALUES ({}, {}, {}, 1, {}, {}, '', {}, 'x', '{{}}')",
            sql_chunk_stable, sql_cid, page_id, sql_canon, sql_title, sql_body
        ));
        crate::svc::sqlite_close();

        indexed_pages += 1;
        indexed_chunks += 1;
        crawl_policy::set_pages_for_collection(&mut state, &cid, pages_here + 1);
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

        // If this collection is now at maxPages, drop its remaining queue
        if pages_here + 1 >= max_pages {
            queue.retain(|q| crate::jsonx::j_get_str(q, "collectionId") != Some(cid.as_str()));
        }
    }

    // Global done: empty queue, or every collection at maxPages with no remaining work
    crate::state::set_field(&mut state, "queue", Json::Arr(queue.clone()));
    let done = queue.is_empty();
    if done
        || crate::jsonx::j_get_u64(&state, "pages", 0) > 0
        || crate::jsonx::j_get_u64(&state, "candidatePages", 0) > 0
    {
        if !write_cand {
            crate::state::set_field(&mut state, "lexicalReady", Json::Bool(true));
        }
        if done {
            if write_cand {
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
                            crate::state::set_field(&mut state, "embeddedChunks", Json::Num(0.0));
                            crate::state::set_field(&mut state, "writeCandidate", Json::Bool(false));
                            crate::state::set_field(&mut state, "generation", Json::Str(gen));
                            crate::state::set_field(
                                &mut state,
                                "message",
                                Json::Str("Candidate promoted".into()),
                            );
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
                crate::state::set_field(
                    &mut state,
                    "message",
                    Json::Str("Lexical index ready".into()),
                );
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

// ── query / RRF ──────────────────────────────────────────────────────────────

struct LexHit {
    id: String,
    collection_id: String,
    page_id: String,
    url: String,
    title: String,
    heading: String,
    snippet: String,
    body: String,
    rank: usize,
}

struct SemHit {
    id: String, // stable_id
    rank: usize,
}

struct Fused {
    id: String,
    collection_id: String,
    page_id: String,
    url: String,
    title: String,
    heading: String,
    snippet: String,
    body: String,
    score: f64,
    lexical_rank: Option<usize>,
    semantic_rank: Option<usize>,
    match_mode: &'static str,
}

fn row_get(cols: &[String], cells: &[Json], name: &str) -> String {
    cols.iter()
        .position(|c| c == name)
        .and_then(|i| cells.get(i))
        .and_then(|v| match v {
            Json::Str(s) => Some(s.clone()),
            Json::Num(n) => Some(format!("{}", n)),
            _ => None,
        })
        .unwrap_or_default()
}

fn push_lex_rows(hits: &mut Vec<LexHit>, r: &Json, start_rank: usize) {
    let Some(rows) = r.get("rows").and_then(|x| x.as_arr()) else {
        return;
    };
    let cols = r
        .get("cols")
        .and_then(|x| x.as_arr())
        .map(|c| {
            c.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for (i, row) in rows.iter().enumerate() {
        if let Some(cells) = row.as_arr() {
            let url = row_get(&cols, cells, "url");
            if !is_http_url(&url) {
                continue;
            }
            let body = row_get(&cols, cells, "body");
            let snippet = {
                let s = row_get(&cols, cells, "snippet");
                if s.is_empty() {
                    body.chars().take(160).collect()
                } else {
                    s
                }
            };
            hits.push(LexHit {
                id: row_get(&cols, cells, "stable_id"),
                collection_id: row_get(&cols, cells, "collection_id"),
                page_id: row_get(&cols, cells, "page_id"),
                url,
                title: row_get(&cols, cells, "title"),
                heading: row_get(&cols, cells, "heading"),
                snippet,
                body,
                rank: start_rank + i + 1,
            });
        }
    }
}

fn lexical_search(collection_id: &str, fts: &str, top_k: usize) -> Vec<LexHit> {
    let mut hits = Vec::new();
    if fts.is_empty() || top_k == 0 {
        return hits;
    }
    let cid = sql_safe::sql_quote_string(collection_id);
    // Primary: FTS5 MATCH (prefix tokens from sql_safe::build_fts_match_query).
    let fts_sql = format!(
        "SELECT c.stable_id, c.collection_id, c.page_id, c.url, c.title, c.heading, c.body, \
         COALESCE(NULLIF(trim(p.description), ''), substr(c.body, 1, 160)) AS snippet \
         FROM chunks_fts \
         JOIN chunks c ON c.id = chunks_fts.rowid \
         LEFT JOIN pages p ON p.id = c.page_id \
         WHERE chunks_fts MATCH {} AND c.collection_id = {} \
         ORDER BY rank, c.id LIMIT {}",
        sql_safe::sql_quote_string(fts),
        cid,
        top_k
    );
    if let Some(r) = crate::svc::sqlite_query(&fts_sql) {
        push_lex_rows(&mut hits, &r, 0);
    }
    if !hits.is_empty() {
        return hits;
    }
    // Fallback: plain LIKE on title/body when FTS is empty (e.g. external-content
    // triggers missed a rebuild). Still collection-scoped; visitor text is escaped.
    // Extract first raw token from the MATCH expression for LIKE (strip quotes/*).
    let like_token = {
        let mut t = String::new();
        for ch in fts.chars() {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                t.push(ch);
            } else if !t.is_empty() {
                break;
            }
        }
        t
    };
    if like_token.is_empty() {
        return hits;
    }
    let pattern = sql_safe::sql_quote_string(&format!("%{}%", like_token));
    let like_sql = format!(
        "SELECT c.stable_id, c.collection_id, c.page_id, c.url, c.title, c.heading, c.body, \
         COALESCE(NULLIF(trim(p.description), ''), substr(c.body, 1, 160)) AS snippet \
         FROM chunks c \
         LEFT JOIN pages p ON p.id = c.page_id \
         WHERE c.collection_id = {} AND (lower(c.title) LIKE lower({}) OR lower(c.body) LIKE lower({})) \
         ORDER BY c.id LIMIT {}",
        cid, pattern, pattern, top_k
    );
    if let Some(r) = crate::svc::sqlite_query(&like_sql) {
        push_lex_rows(&mut hits, &r, 0);
    }
    hits
}

fn embed_query_vector(query: &str) -> Option<Vec<f64>> {
    let args = crate::jsonx::j_obj(alloc::vec![
        (
            "texts".into(),
            Json::Arr(alloc::vec![Json::Str(query.into())])
        ),
        ("kind".into(), Json::Str("query".into())),
    ]);
    let wrap = crate::svc::tools_call(crate::paths::EMBED_ADDR, args)?;
    let data = if crate::jsonx::j_get_bool(&wrap, "ok") {
        wrap.get("data").cloned().unwrap_or(wrap)
    } else {
        return None;
    };
    let vectors = data.get("vectors")?.as_arr()?;
    let first = vectors.first()?.as_arr()?;
    let mut out = Vec::with_capacity(first.len());
    for v in first {
        out.push(v.as_f64().unwrap_or(0.0));
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn semantic_search(collection_id: &str, vector: &[f64], top_k: usize) -> Vec<SemHit> {
    let mut hits = Vec::new();
    if vector.is_empty() || top_k == 0 {
        return hits;
    }
    let vec_lit = sql_safe::sql_vec_f32(vector);
    // VANN: partition filter on collection_id, k hidden column.
    let sql = format!(
        "SELECT cv.rowid AS rid, c.stable_id \
         FROM chunk_vec cv \
         JOIN chunks c ON c.id = cv.rowid \
         WHERE cv.embedding MATCH {} AND k = {} AND cv.collection_id = {} \
         ORDER BY distance, cv.rowid LIMIT {}",
        vec_lit,
        top_k,
        sql_safe::sql_quote_string(collection_id),
        top_k
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
                    let sid = row_get(&cols, cells, "stable_id");
                    if sid.is_empty() {
                        continue;
                    }
                    hits.push(SemHit {
                        id: sid,
                        rank: rank + 1,
                    });
                }
            }
        }
    }
    hits
}

fn hydrate_chunks(ids: &[String]) -> Vec<LexHit> {
    let mut out = Vec::new();
    if ids.is_empty() {
        return out;
    }
    // Build IN list with quoted stable_ids (bounded top-k only).
    let mut in_list = String::new();
    for (i, id) in ids.iter().enumerate() {
        if i > 0 {
            in_list.push(',');
        }
        in_list.push_str(&sql_safe::sql_quote_string(id));
    }
    let sql = format!(
        "SELECT stable_id, collection_id, page_id, url, title, heading, body \
         FROM chunks WHERE stable_id IN ({}) LIMIT {}",
        in_list,
        ids.len()
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
            for row in rows {
                if let Some(cells) = row.as_arr() {
                    let body = row_get(&cols, cells, "body");
                    let snippet: String = body.chars().take(160).collect();
                    out.push(LexHit {
                        id: row_get(&cols, cells, "stable_id"),
                        collection_id: row_get(&cols, cells, "collection_id"),
                        page_id: row_get(&cols, cells, "page_id"),
                        url: row_get(&cols, cells, "url"),
                        title: row_get(&cols, cells, "title"),
                        heading: row_get(&cols, cells, "heading"),
                        snippet,
                        body,
                        rank: 0,
                    });
                }
            }
        }
    }
    out
}

fn fuse_rrf(
    lexical: &[LexHit],
    semantic: &[SemHit],
    rrf_k: f64,
    per_page: usize,
    limit: usize,
) -> Vec<Fused> {
    // Map id → fused accumulator
    struct Acc {
        score: f64,
        lexical_rank: Option<usize>,
        semantic_rank: Option<usize>,
        meta: Option<LexHit>,
    }
    let mut map: Vec<(String, Acc)> = Vec::new();

    let find = |map: &mut Vec<(String, Acc)>, id: &str| -> usize {
        if let Some(i) = map.iter().position(|(k, _)| k == id) {
            i
        } else {
            map.push((
                id.to_string(),
                Acc {
                    score: 0.0,
                    lexical_rank: None,
                    semantic_rank: None,
                    meta: None,
                },
            ));
            map.len() - 1
        }
    };

    for h in lexical {
        let i = find(&mut map, &h.id);
        map[i].1.score += 1.0 / (rrf_k + h.rank as f64);
        map[i].1.lexical_rank = Some(h.rank);
        map[i].1.meta = Some(LexHit {
            id: h.id.clone(),
            collection_id: h.collection_id.clone(),
            page_id: h.page_id.clone(),
            url: h.url.clone(),
            title: h.title.clone(),
            heading: h.heading.clone(),
            snippet: h.snippet.clone(),
            body: h.body.clone(),
            rank: h.rank,
        });
    }
    for h in semantic {
        let i = find(&mut map, &h.id);
        map[i].1.score += 1.0 / (rrf_k + h.rank as f64);
        map[i].1.semantic_rank = Some(h.rank);
    }

    // Hydrate semantic-only ids missing meta
    let need: Vec<String> = map
        .iter()
        .filter(|(_, a)| a.meta.is_none())
        .map(|(id, _)| id.clone())
        .collect();
    if !need.is_empty() {
        let hydrated = hydrate_chunks(&need);
        for h in hydrated {
            if let Some(i) = map.iter().position(|(k, _)| k == &h.id) {
                map[i].1.meta = Some(h);
            }
        }
    }

    // Sort by score desc, then id asc
    map.sort_by(|a, b| {
        b.1.score
            .partial_cmp(&a.1.score)
            .unwrap_or(core::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });

    let mut out = Vec::new();
    let mut page_counts: Vec<(String, usize)> = Vec::new();
    for (id, acc) in map {
        let Some(meta) = acc.meta else {
            continue;
        };
        if !is_http_url(&meta.url) {
            continue;
        }
        // Per-page diversity
        let page_key = meta.page_id.clone();
        let count = page_counts
            .iter()
            .find(|(p, _)| p == &page_key)
            .map(|(_, c)| *c)
            .unwrap_or(0);
        if per_page > 0 && count >= per_page {
            continue;
        }
        if let Some((_, c)) = page_counts.iter_mut().find(|(p, _)| p == &page_key) {
            *c += 1;
        } else {
            page_counts.push((page_key, 1));
        }
        let match_mode = match (acc.lexical_rank, acc.semantic_rank) {
            (Some(_), Some(_)) => "hybrid",
            (Some(_), None) => "lexical",
            (None, Some(_)) => "semantic",
            _ => "lexical",
        };
        out.push(Fused {
            id,
            collection_id: meta.collection_id,
            page_id: meta.page_id,
            url: meta.url,
            title: meta.title,
            heading: meta.heading,
            snippet: meta.snippet,
            body: meta.body,
            score: acc.score,
            lexical_rank: acc.lexical_rank,
            semantic_rank: acc.semantic_rank,
            match_mode,
        });
        if out.len() >= limit {
            break;
        }
    }
    out
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
    let limit = sql_safe::clamp_limit(crate::jsonx::j_get_u64(req, "limit", 10), 10, 50) as usize;
    let candidate_limit = sql_safe::clamp_limit(
        crate::jsonx::j_get_u64(req, "candidateLimit", (limit * 3) as u64),
        (limit * 3) as u64,
        100,
    ) as usize;
    let per_page =
        sql_safe::clamp_limit(crate::jsonx::j_get_u64(req, "perPageLimit", 2), 2, 10) as usize;
    let rrf_k = {
        let raw = crate::jsonx::j_get_u64(req, "rrfK", 60);
        if raw == 0 {
            60.0
        } else {
            raw as f64
        }
    };
    let semantic_ready = crate::jsonx::j_get_bool(&state, "semanticReady");
    let fts = sql_safe::build_fts_match_query(q, 16);

    let mut hits_json = Vec::new();
    if !crate::svc::sqlite_open(crate::paths::INDEX_PATH) {
        return crate::jsonx::ok_resp(
            id,
            "query",
            alloc::vec![
                ("status".into(), crate::state::status_body(&state)),
                ("hits".into(), Json::Arr(Vec::new())),
                ("semanticAvailable".into(), Json::Bool(semantic_ready)),
            ],
        );
    }

    let lexical = if fts.is_empty() {
        Vec::new()
    } else {
        lexical_search(collection_id, &fts, candidate_limit)
    };

    let mut semantic: Vec<SemHit> = Vec::new();
    if semantic_ready && !q.trim().is_empty() {
        // Prefer host-provided queryVector when present; else embed via host tool.
        let provided = req.get("queryVector").and_then(|v| v.as_arr()).and_then(|arr| {
            if arr.is_empty() {
                return None;
            }
            let mut out = Vec::with_capacity(arr.len());
            for x in arr {
                out.push(x.as_f64().unwrap_or(0.0));
            }
            Some(out)
        });
        if let Some(vec) = provided.or_else(|| embed_query_vector(q)) {
            semantic = semantic_search(collection_id, &vec, candidate_limit);
        }
        // Query-time embed failure → semantic list empty; lexical hits still returned.
    }

    let fused = if !semantic.is_empty() || !lexical.is_empty() {
        fuse_rrf(&lexical, &semantic, rrf_k, per_page, limit)
    } else {
        Vec::new()
    };

    crate::svc::sqlite_close();

    for (i, h) in fused.into_iter().enumerate() {
        let mut pairs = alloc::vec![
            ("id".into(), Json::Str(h.id)),
            ("collectionId".into(), Json::Str(h.collection_id)),
            (
                "pageId".into(),
                h.page_id
                    .parse::<f64>()
                    .map(Json::Num)
                    .unwrap_or(Json::Str(h.page_id.clone()))
            ),
            ("url".into(), Json::Str(h.url)),
            ("title".into(), Json::Str(h.title)),
            ("heading".into(), Json::Str(h.heading)),
            ("snippet".into(), Json::Str(h.snippet)),
            ("body".into(), Json::Str(h.body)),
            ("score".into(), Json::Num(h.score)),
            ("fusedRank".into(), Json::Num((i + 1) as f64)),
            ("matchMode".into(), Json::Str(h.match_mode.into())),
        ];
        if let Some(r) = h.lexical_rank {
            pairs.push(("lexicalRank".into(), Json::Num(r as f64)));
        }
        if let Some(r) = h.semantic_rank {
            pairs.push(("semanticRank".into(), Json::Num(r as f64)));
        }
        hits_json.push(crate::jsonx::j_obj(pairs));
    }

    // Honest: semanticAvailable reflects index readiness, not this query's embed success.
    crate::jsonx::ok_resp(
        id,
        "query",
        alloc::vec![
            ("status".into(), crate::state::status_body(&state)),
            ("hits".into(), Json::Arr(hits_json)),
            ("semanticAvailable".into(), Json::Bool(semantic_ready)),
        ],
    )
}

// ── embed_step ───────────────────────────────────────────────────────────────

fn mixedbread_document_text(title: &str, heading: &str, body: &str) -> String {
    let mut parts = Vec::new();
    let t = title.trim();
    let h = heading.trim();
    let b = body.trim();
    if !t.is_empty() {
        parts.push(t);
    }
    if !h.is_empty() {
        parts.push(h);
    }
    if !b.is_empty() {
        parts.push(b);
    }
    parts.join("\n")
}

fn handle_embed_step(req: &Json) -> Json {
    let id = crate::jsonx::j_get_str(req, "id").unwrap_or("embed");
    let mut state = crate::state::load_state();
    if !crate::jsonx::j_get_bool(&state, "lexicalReady")
        && !crate::jsonx::j_get_bool(&state, "writeCandidate")
    {
        return crate::jsonx::err_resp(id, "not_ready", "lexical index not ready");
    }
    let max_chunks =
        sql_safe::clamp_limit(crate::jsonx::j_get_u64(req, "maxChunks", 8), 8, 64) as usize;
    let write_cand = crate::jsonx::j_get_bool(&state, "writeCandidate");
    let db_path = if write_cand {
        crate::paths::CANDIDATE_PATH
    } else {
        crate::paths::INDEX_PATH
    };

    if !crate::svc::sqlite_open(db_path) {
        crate::state::set_field(&mut state, "semanticReady", Json::Bool(false));
        crate::state::set_field(
            &mut state,
            "message",
            Json::Str("Embed failed: cannot open index".into()),
        );
        crate::state::save_state(&state);
        return crate::jsonx::ok_resp(
            id,
            "embed_step",
            alloc::vec![
                ("status".into(), crate::state::status_body(&state)),
                (
                    "progress".into(),
                    crate::jsonx::j_obj(alloc::vec![
                        (
                            "embeddedChunks".into(),
                            Json::Num(crate::jsonx::j_get_u64(&state, "embeddedChunks", 0) as f64)
                        ),
                        ("done".into(), Json::Bool(false)),
                    ]),
                ),
            ],
        );
    }

    // Chunks not yet in chunk_vec
    let select_sql = format!(
        "SELECT c.id, c.collection_id, c.page_id, c.title, c.heading, c.body \
         FROM chunks c \
         WHERE NOT EXISTS (SELECT 1 FROM chunk_vec cv WHERE cv.rowid = c.id) \
         ORDER BY c.id LIMIT {}",
        max_chunks
    );
    let mut pending: Vec<(i64, String, i64, String, String, String)> = Vec::new();
    if let Some(r) = crate::svc::sqlite_query(&select_sql) {
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
            for row in rows {
                if let Some(cells) = row.as_arr() {
                    let cid_row = row_get(&cols, cells, "id")
                        .parse::<i64>()
                        .unwrap_or(0);
                    if cid_row == 0 {
                        continue;
                    }
                    let page_id = row_get(&cols, cells, "page_id")
                        .parse::<i64>()
                        .unwrap_or(0);
                    pending.push((
                        cid_row,
                        row_get(&cols, cells, "collection_id"),
                        page_id,
                        row_get(&cols, cells, "title"),
                        row_get(&cols, cells, "heading"),
                        row_get(&cols, cells, "body"),
                    ));
                }
            }
        }
    }

    if pending.is_empty() {
        // No remaining chunks — semantic ready (if any chunks exist at all)
        let total = crate::svc::sqlite_query("SELECT COUNT(*) AS n FROM chunks")
            .and_then(|r| {
                let rows = r.get("rows")?.as_arr()?;
                let row = rows.first()?.as_arr()?;
                row.first()?.as_f64().map(|n| n as u64)
            })
            .unwrap_or(0);
        crate::svc::sqlite_close();
        let embedded = crate::jsonx::j_get_u64(&state, "embeddedChunks", 0).max(total);
        crate::state::set_field(&mut state, "embeddedChunks", Json::Num(embedded as f64));
        if total > 0 {
            crate::state::set_field(&mut state, "semanticReady", Json::Bool(true));
            crate::state::set_field(&mut state, "phase", Json::Str("semantic_ready".into()));
            crate::state::set_field(
                &mut state,
                "message",
                Json::Str("Semantic index ready".into()),
            );
        } else {
            // Empty index: stay lexical, not semantic
            crate::state::set_field(&mut state, "semanticReady", Json::Bool(false));
            crate::state::set_field(&mut state, "phase", Json::Str("lexical_ready".into()));
        }
        crate::state::save_state(&state);
        return crate::jsonx::ok_resp(
            id,
            "embed_step",
            alloc::vec![
                ("status".into(), crate::state::status_body(&state)),
                (
                    "progress".into(),
                    crate::jsonx::j_obj(alloc::vec![
                        ("embeddedChunks".into(), Json::Num(embedded as f64)),
                        ("done".into(), Json::Bool(true)),
                    ]),
                ),
            ],
        );
    }

    // Build Mixedbread-style document texts
    let mut texts = Vec::new();
    for (_, _, _, title, heading, body) in &pending {
        texts.push(Json::Str(mixedbread_document_text(title, heading, body)));
    }
    let args = crate::jsonx::j_obj(alloc::vec![
        ("texts".into(), Json::Arr(texts)),
        ("kind".into(), Json::Str("document".into())),
    ]);

    let embed_result = crate::svc::tools_call(crate::paths::EMBED_ADDR, args);
    let vectors: Option<Vec<Vec<f64>>> = embed_result.and_then(|wrap| {
        let data = if crate::jsonx::j_get_bool(&wrap, "ok") {
            wrap.get("data").cloned().unwrap_or(wrap)
        } else {
            return None;
        };
        let arr = data.get("vectors")?.as_arr()?;
        let mut out = Vec::new();
        for row in arr {
            let cells = row.as_arr()?;
            let mut v = Vec::with_capacity(cells.len());
            for c in cells {
                v.push(c.as_f64().unwrap_or(0.0));
            }
            out.push(v);
        }
        Some(out)
    });

    let Some(vectors) = vectors else {
        crate::svc::sqlite_close();
        // Do NOT set semanticReady true on embed failure; leave lexical up
        crate::state::set_field(&mut state, "semanticReady", Json::Bool(false));
        if crate::jsonx::j_get_bool(&state, "lexicalReady") {
            crate::state::set_field(&mut state, "phase", Json::Str("lexical_ready".into()));
        }
        crate::state::set_field(
            &mut state,
            "message",
            Json::Str("Lexical index ready (embed unavailable)".into()),
        );
        crate::state::save_state(&state);
        return crate::jsonx::ok_resp(
            id,
            "embed_step",
            alloc::vec![
                ("status".into(), crate::state::status_body(&state)),
                (
                    "progress".into(),
                    crate::jsonx::j_obj(alloc::vec![
                        (
                            "embeddedChunks".into(),
                            Json::Num(crate::jsonx::j_get_u64(&state, "embeddedChunks", 0) as f64)
                        ),
                        ("done".into(), Json::Bool(false)),
                    ]),
                ),
            ],
        );
    };

    if vectors.len() != pending.len() {
        crate::svc::sqlite_close();
        crate::state::set_field(&mut state, "semanticReady", Json::Bool(false));
        crate::state::set_field(
            &mut state,
            "message",
            Json::Str("Embed batch size mismatch".into()),
        );
        crate::state::save_state(&state);
        return crate::jsonx::ok_resp(
            id,
            "embed_step",
            alloc::vec![
                ("status".into(), crate::state::status_body(&state)),
                (
                    "progress".into(),
                    crate::jsonx::j_obj(alloc::vec![
                        (
                            "embeddedChunks".into(),
                            Json::Num(crate::jsonx::j_get_u64(&state, "embeddedChunks", 0) as f64)
                        ),
                        ("done".into(), Json::Bool(false)),
                    ]),
                ),
            ],
        );
    }

    let mut inserted = 0u64;
    for (i, (rowid, collection_id, page_id, _, _, _)) in pending.iter().enumerate() {
        let vec_lit = sql_safe::sql_vec_f32(&vectors[i]);
        let sql = format!(
            "INSERT INTO chunk_vec(rowid, embedding, collection_id, page_id, updated_at) VALUES ({}, {}, {}, {}, strftime('%s','now'))",
            rowid,
            vec_lit,
            sql_safe::sql_quote_string(collection_id),
            page_id,
        );
        if crate::svc::sqlite_exec(&sql) {
            inserted += 1;
        }
    }

    // Remaining?
    let remaining = crate::svc::sqlite_query(
        "SELECT COUNT(*) AS n FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM chunk_vec cv WHERE cv.rowid = c.id)",
    )
    .and_then(|r| {
        let rows = r.get("rows")?.as_arr()?;
        let row = rows.first()?.as_arr()?;
        row.first()?.as_f64().map(|n| n as u64)
    })
    .unwrap_or(1);
    crate::svc::sqlite_close();

    let prev = crate::jsonx::j_get_u64(&state, "embeddedChunks", 0);
    let embedded = prev + inserted;
    crate::state::set_field(&mut state, "embeddedChunks", Json::Num(embedded as f64));
    crate::state::set_field(&mut state, "phase", Json::Str("embedding".into()));

    let done = remaining == 0;
    if done {
        crate::state::set_field(&mut state, "semanticReady", Json::Bool(true));
        crate::state::set_field(&mut state, "phase", Json::Str("semantic_ready".into()));
        crate::state::set_field(
            &mut state,
            "message",
            Json::Str("Semantic index ready".into()),
        );
    } else {
        // Partial progress — do not claim semanticReady yet
        crate::state::set_field(&mut state, "semanticReady", Json::Bool(false));
        crate::state::set_field(
            &mut state,
            "message",
            Json::Str(format!("Embedding… {} done, {} remaining", embedded, remaining)),
        );
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
                    ("embeddedChunks".into(), Json::Num(embedded as f64)),
                    ("done".into(), Json::Bool(done)),
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
    crate::state::set_field(&mut state, "candidateGeneration", Json::Str(cand_id));
    crate::state::set_field(&mut state, "candidatePages", Json::Num(0.0));
    crate::state::set_field(&mut state, "candidateChunks", Json::Num(0.0));
    crate::state::set_field(&mut state, "phase", Json::Str("refreshing".into()));
    crate::state::set_field(
        &mut state,
        "message",
        Json::Str("Refreshing candidate generation".into()),
    );
    crate::state::set_field(&mut state, "visited", Json::Arr(Vec::new()));
    crate::state::set_field(&mut state, "robots", Json::Obj(Vec::new()));
    crate::state::set_field(&mut state, "sitemapSeeded", Json::Arr(Vec::new()));
    crate::state::set_field(&mut state, "pagesByCollection", Json::Obj(Vec::new()));

    // re-seed queue from collections with path policy
    let mut queue = Vec::new();
    if let Some(Json::Arr(cols)) = state.get("collections") {
        for c in cols {
            let cid = crate::jsonx::j_get_str(c, "id").unwrap_or("site");
            let inc = crawl_policy::collection_includes(c);
            let exc = crawl_policy::collection_excludes(c);
            if let Json::Arr(seeds) = c.get("seeds").unwrap_or(&Json::Arr(Vec::new())) {
                for s in seeds {
                    if let Some(url) = crate::jsonx::j_str(s) {
                        if !is_http_url(url) {
                            continue;
                        }
                        if let Some(path) = crawl_policy::url_pathname(url) {
                            if !crawl_policy::path_allowed(&path, &inc, &exc) {
                                continue;
                            }
                        } else {
                            continue;
                        }
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

    let schema = crate::jsonx::j_get_str(&state, "schemaSql")
        .unwrap_or("")
        .to_string();
    if crate::svc::sqlite_open(crate::paths::CANDIDATE_PATH) {
        if !schema.is_empty() {
            crate::svc::apply_schema(&schema);
        }
        crate::svc::sqlite_close();
    }
    crate::state::save_state(&state);
    crate::jsonx::ok_resp(
        id,
        "refresh",
        alloc::vec![("status".into(), crate::state::status_body(&state))],
    )
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
                crate::jsonx::j_obj(alloc::vec![(
                    "kind".into(),
                    Json::Str(if crate::jsonx::j_get_bool(&state, "semanticReady") {
                        "semantic".into()
                    } else if crate::jsonx::j_get_bool(&state, "lexicalReady") {
                        "lexical".into()
                    } else {
                        "idle".into()
                    })
                ),]),
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
    crate::jsonx::ok_resp(
        id,
        "promote",
        alloc::vec![("status".into(), crate::state::status_body(&state))],
    )
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
            None => {
                json::to_string(&crate::jsonx::err_resp("none", "bad_json", "request must be JSON"))
            }
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
