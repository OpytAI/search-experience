//! Per-collection path policy, robots.txt, and light sitemap helpers.
//!
//! Pure logic lives here so crawl handlers stay thin and rules are auditable.

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use json::Json;

/// Default max pages per collection when configure omits `maxPages`.
pub(crate) const DEFAULT_MAX_PAGES: u64 = 50;
/// Hard ceiling so a misconfigured collection cannot unbounded-grow the index.
pub(crate) const HARD_MAX_PAGES: u64 = 5_000;
pub(crate) const DEFAULT_MAX_QUEUE: u64 = 200;
pub(crate) const HARD_MAX_QUEUE: u64 = 20_000;
pub(crate) const DEFAULT_MAX_SITEMAPS: u64 = 5;
pub(crate) const HARD_MAX_SITEMAPS: u64 = 20;

/// Pathname of a URL string without allocating a full parser when possible.
/// Returns `None` if the string is not an absolute http(s) URL with a path.
pub(crate) fn url_pathname(url: &str) -> Option<String> {
    let rest = if let Some(r) = url.strip_prefix("https://") {
        r
    } else if let Some(r) = url.strip_prefix("http://") {
        r
    } else {
        return None;
    };
    // Skip authority (host[:port])
    let path_start = rest.find('/').unwrap_or(rest.len());
    let after_auth = &rest[path_start..];
    // Drop query/fragment
    let path = after_auth
        .split(|c| c == '?' || c == '#')
        .next()
        .unwrap_or("");
    if path.is_empty() {
        Some(String::from("/"))
    } else {
        Some(path.to_string())
    }
}

/// Origin (`scheme://host[:port]`) for an absolute http(s) URL.
pub(crate) fn url_origin(url: &str) -> Option<String> {
    let (scheme, rest) = if let Some(r) = url.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = url.strip_prefix("http://") {
        ("http", r)
    } else {
        return None;
    };
    let auth_end = rest.find('/').unwrap_or(rest.len());
    let auth = &rest[..auth_end];
    if auth.is_empty() {
        return None;
    }
    // Drop userinfo if present
    let hostport = auth.rsplit('@').next().unwrap_or(auth);
    if hostport.is_empty() {
        return None;
    }
    Some(format!("{}://{}", scheme, hostport))
}

/// True when `path` starts with `prefix` as a path prefix.
/// Empty prefix never matches; both should be path-shaped (`/…`).
pub(crate) fn path_starts_with(path: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return false;
    }
    path.starts_with(prefix)
}

/// Whether a URL path is allowed for a collection's include/exclude prefixes.
///
/// Rules (mirrors TS `src/security/paths.ts` and publisher `collectionAcceptsUrl`):
/// 1. Any matching exclude prefix → reject
/// 2. If include list is empty → accept
/// 3. Else accept only if some include prefix matches
pub(crate) fn path_allowed(
    path: &str,
    include_prefixes: &[&str],
    exclude_prefixes: &[&str],
) -> bool {
    for ex in exclude_prefixes {
        if path_starts_with(path, ex) {
            return false;
        }
    }
    if include_prefixes.is_empty() {
        return true;
    }
    for inc in include_prefixes {
        if path_starts_with(path, inc) {
            return true;
        }
    }
    false
}

fn j_str_list<'a>(obj: &'a Json, key: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    if let Some(Json::Arr(items)) = obj.get(key) {
        for item in items {
            if let Some(s) = item.as_str() {
                if !s.is_empty() {
                    out.push(s);
                }
            }
        }
    }
    out
}

/// Resolve maxPages for a collection JSON object (default 50, hard-capped).
pub(crate) fn collection_max_pages(col: &Json) -> u64 {
    let raw = crate::jsonx::j_get_u64(col, "maxPages", DEFAULT_MAX_PAGES);
    let v = if raw == 0 { DEFAULT_MAX_PAGES } else { raw };
    if v > HARD_MAX_PAGES {
        HARD_MAX_PAGES
    } else {
        v
    }
}

pub(crate) fn collection_max_queue(col: &Json) -> u64 {
    let max_pages = collection_max_pages(col);
    let raw = crate::jsonx::j_get_u64(col, "maxQueue", DEFAULT_MAX_QUEUE.max(max_pages * 4));
    let v = if raw == 0 {
        DEFAULT_MAX_QUEUE.max(max_pages * 4)
    } else {
        raw
    };
    if v > HARD_MAX_QUEUE {
        HARD_MAX_QUEUE
    } else {
        v
    }
}

pub(crate) fn collection_max_sitemaps(col: &Json) -> u64 {
    let raw = crate::jsonx::j_get_u64(col, "maxSitemaps", DEFAULT_MAX_SITEMAPS);
    if raw > HARD_MAX_SITEMAPS {
        HARD_MAX_SITEMAPS
    } else {
        raw
    }
}

/// Look up a collection object by id from the state `collections` array.
pub(crate) fn find_collection<'a>(state: &'a Json, collection_id: &str) -> Option<&'a Json> {
    let Json::Arr(cols) = state.get("collections")? else {
        return None;
    };
    cols.iter().find(|c| {
        crate::jsonx::j_get_str(c, "id").unwrap_or("") == collection_id
    })
}

/// Include prefixes for a collection.
pub(crate) fn collection_includes(col: &Json) -> Vec<&str> {
    j_str_list(col, "includePathPrefixes")
}

/// Exclude prefixes for a collection.
pub(crate) fn collection_excludes(col: &Json) -> Vec<&str> {
    j_str_list(col, "excludePathPrefixes")
}

/// True if URL passes path policy for the given collection (when known).
/// Unknown collection → only require a valid path.
pub(crate) fn url_allowed_for_collection(state: &Json, collection_id: &str, url: &str) -> bool {
    let Some(path) = url_pathname(url) else {
        return false;
    };
    if let Some(col) = find_collection(state, collection_id) {
        let inc = collection_includes(col);
        let exc = collection_excludes(col);
        path_allowed(&path, &inc, &exc)
    } else {
        true
    }
}

// ── robots.txt ───────────────────────────────────────────────────────────────

/// Parsed robots policy for one origin (basic Disallow prefixes).
#[derive(Clone)]
pub(crate) struct RobotsPolicy {
    /// When true, all paths are denied (fetch failed → deny-by-default).
    pub deny_all: bool,
    pub disallow: Vec<String>,
    pub sitemaps: Vec<String>,
}

impl RobotsPolicy {
    pub(crate) fn empty_allow() -> Self {
        Self {
            deny_all: false,
            disallow: Vec::new(),
            sitemaps: Vec::new(),
        }
    }

    pub(crate) fn deny() -> Self {
        Self {
            deny_all: true,
            disallow: alloc::vec![String::from("/")],
            sitemaps: Vec::new(),
        }
    }

    /// Honor Disallow path prefixes for the selected group.
    /// Empty disallow path means "allow all" for that rule (ignored as a block).
    pub(crate) fn allows_path(&self, path: &str) -> bool {
        if self.deny_all {
            return false;
        }
        for d in &self.disallow {
            if d.is_empty() {
                continue;
            }
            // "/" disallows everything
            if d == "/" {
                return false;
            }
            if path_starts_with(path, d) {
                return false;
            }
        }
        true
    }

    pub(crate) fn allows_url(&self, url: &str) -> bool {
        let path = url_pathname(url).unwrap_or_else(|| String::from("/"));
        self.allows_path(&path)
    }

    pub(crate) fn to_json(&self) -> Json {
        let disallow = self
            .disallow
            .iter()
            .map(|s| Json::Str(s.clone()))
            .collect::<Vec<_>>();
        let sitemaps = self
            .sitemaps
            .iter()
            .map(|s| Json::Str(s.clone()))
            .collect::<Vec<_>>();
        crate::jsonx::j_obj(alloc::vec![
            ("denyAll".into(), Json::Bool(self.deny_all)),
            ("disallow".into(), Json::Arr(disallow)),
            ("sitemaps".into(), Json::Arr(sitemaps)),
        ])
    }

    pub(crate) fn from_json(j: &Json) -> Self {
        let deny_all = crate::jsonx::j_get_bool(j, "denyAll");
        let mut disallow = Vec::new();
        if let Some(Json::Arr(items)) = j.get("disallow") {
            for item in items {
                if let Some(s) = item.as_str() {
                    disallow.push(s.to_string());
                }
            }
        }
        let mut sitemaps = Vec::new();
        if let Some(Json::Arr(items)) = j.get("sitemaps") {
            for item in items {
                if let Some(s) = item.as_str() {
                    sitemaps.push(s.to_string());
                }
            }
        }
        Self {
            deny_all,
            disallow,
            sitemaps,
        }
    }
}

/// Parse robots.txt body. Selects User-agent groups for `AgentOSSearch` (case-insensitive
/// substring) preferentially, else `*`. Collects Disallow paths and Sitemap URLs.
pub(crate) fn parse_robots_txt(body: &str) -> RobotsPolicy {
    struct Group {
        agents: Vec<String>,
        disallow: Vec<String>,
    }
    let mut groups: Vec<Group> = Vec::new();
    let mut sitemaps: Vec<String> = Vec::new();
    let mut current: Option<Group> = None;
    let mut saw_rule = false;

    for raw_line in body.split('\n') {
        let line = raw_line
            .split('#')
            .next()
            .unwrap_or("")
            .trim();
        if line.is_empty() {
            continue;
        }
        let Some(colon) = line.find(':') else {
            continue;
        };
        let key = line[..colon].trim().to_ascii_lowercase();
        let value = line[colon + 1..].trim();
        match key.as_str() {
            "sitemap" => {
                if !value.is_empty() {
                    sitemaps.push(value.to_string());
                }
            }
            "user-agent" => {
                if current.is_none() || saw_rule {
                    if let Some(g) = current.take() {
                        groups.push(g);
                    }
                    current = Some(Group {
                        agents: Vec::new(),
                        disallow: Vec::new(),
                    });
                    saw_rule = false;
                }
                if let Some(ref mut g) = current {
                    g.agents.push(value.to_ascii_lowercase());
                }
            }
            "disallow" => {
                if let Some(ref mut g) = current {
                    saw_rule = true;
                    // Empty Disallow means allow all for that rule — skip as a block entry.
                    if !value.is_empty() {
                        g.disallow.push(value.to_string());
                    }
                }
            }
            "allow" => {
                // Basic policy: we only honor Disallow prefixes; Allow is recorded as
                // presence of a rule so the group stays selected.
                if current.is_some() {
                    saw_rule = true;
                }
            }
            _ => {}
        }
    }
    if let Some(g) = current.take() {
        groups.push(g);
    }

    let ua = "agentossearch";
    let mut specific: Vec<&Group> = Vec::new();
    let mut star: Vec<&Group> = Vec::new();
    for g in &groups {
        // Prefer agent names that match AgentOSSearch as substring either way.
        let match_specific = g.agents.iter().any(|a| {
            if a == "*" || a.is_empty() {
                return false;
            }
            ua.contains(a.as_str()) || a.contains(ua) || a.starts_with("agentos")
        });
        if match_specific {
            specific.push(g);
        }
        if g.agents.iter().any(|a| a == "*") {
            star.push(g);
        }
    }
    let selected: Vec<&Group> = if !specific.is_empty() {
        specific
    } else {
        star
    };
    let mut disallow = Vec::new();
    for g in selected {
        for d in &g.disallow {
            if !disallow.iter().any(|x: &String| x == d) {
                disallow.push(d.clone());
            }
        }
    }
    RobotsPolicy {
        deny_all: false,
        disallow,
        sitemaps,
    }
}

// ── sitemap ──────────────────────────────────────────────────────────────────

/// Extract `<loc>…</loc>` URLs from a sitemap or sitemap-index body (bounded).
pub(crate) fn sitemap_locations(xml: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let lower_hint = xml; // keep original for slicing
    let bytes = lower_hint.as_bytes();
    let mut i = 0usize;
    while i + 5 < bytes.len() && out.len() < max {
        // Find <loc case-insensitively
        let rest = &lower_hint[i..];
        let Some(rel) = find_ci(rest, "<loc") else {
            break;
        };
        let after_tag = i + rel + 4;
        // skip attributes to '>'
        let Some(gt_rel) = lower_hint[after_tag..].find('>') else {
            break;
        };
        let content_start = after_tag + gt_rel + 1;
        let Some(end_rel) = find_ci(&lower_hint[content_start..], "</loc>") else {
            break;
        };
        let content_end = content_start + end_rel;
        let raw = lower_hint[content_start..content_end].trim();
        let decoded = decode_xml_entities(raw);
        if decoded.starts_with("http://") || decoded.starts_with("https://") {
            out.push(decoded);
        }
        i = content_end + 6;
    }
    out
}

fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let h = hay.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    'outer: for i in 0..=(h.len() - n.len()) {
        for j in 0..n.len() {
            let a = h[i + j].to_ascii_lowercase();
            let b = n[j].to_ascii_lowercase();
            if a != b {
                continue 'outer;
            }
        }
        return Some(i);
    }
    None
}

fn decode_xml_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        if rest.starts_with("&amp;") {
            out.push('&');
            rest = &rest[5..];
        } else if rest.starts_with("&lt;") {
            out.push('<');
            rest = &rest[4..];
        } else if rest.starts_with("&gt;") {
            out.push('>');
            rest = &rest[4..];
        } else if rest.starts_with("&quot;") {
            out.push('"');
            rest = &rest[6..];
        } else if rest.starts_with("&apos;") {
            out.push('\'');
            rest = &rest[6..];
        } else {
            out.push('&');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

/// Pages already indexed for a collection (from state.pagesByCollection).
pub(crate) fn pages_for_collection(state: &Json, collection_id: &str) -> u64 {
    if let Some(Json::Obj(pairs)) = state.get("pagesByCollection") {
        for (k, v) in pairs {
            if k == collection_id {
                return v.as_u64().unwrap_or(0);
            }
        }
    }
    0
}

pub(crate) fn set_pages_for_collection(state: &mut Json, collection_id: &str, count: u64) {
    let value = Json::Num(count as f64);
    if let Json::Obj(ref mut pairs) = state {
        if let Some((_, Json::Obj(map))) = pairs.iter_mut().find(|(k, _)| k == "pagesByCollection") {
            if let Some((_, v)) = map.iter_mut().find(|(k, _)| k == collection_id) {
                *v = value;
            } else {
                map.push((collection_id.into(), value));
            }
            return;
        }
        // insert pagesByCollection object
        pairs.push((
            "pagesByCollection".into(),
            Json::Obj(alloc::vec![(collection_id.into(), value)]),
        ));
    }
}

/// Visited URL membership via state.visited string array.
pub(crate) fn is_visited(state: &Json, url: &str) -> bool {
    if let Some(Json::Arr(items)) = state.get("visited") {
        for item in items {
            if item.as_str() == Some(url) {
                return true;
            }
        }
    }
    false
}

pub(crate) fn mark_visited(state: &mut Json, url: &str) {
    if is_visited(state, url) {
        return;
    }
    if let Json::Obj(ref mut pairs) = state {
        if let Some((_, Json::Arr(items))) = pairs.iter_mut().find(|(k, _)| k == "visited") {
            items.push(Json::Str(url.into()));
            return;
        }
        pairs.push((
            "visited".into(),
            Json::Arr(alloc::vec![Json::Str(url.into())]),
        ));
    }
}

/// Robots cache get/set under state.robots[origin].
pub(crate) fn robots_cached(state: &Json, origin: &str) -> Option<RobotsPolicy> {
    let Json::Obj(pairs) = state.get("robots")? else {
        return None;
    };
    for (k, v) in pairs {
        if k == origin {
            return Some(RobotsPolicy::from_json(v));
        }
    }
    None
}

pub(crate) fn robots_store(state: &mut Json, origin: &str, policy: &RobotsPolicy) {
    let entry = policy.to_json();
    if let Json::Obj(ref mut pairs) = state {
        if let Some((_, Json::Obj(map))) = pairs.iter_mut().find(|(k, _)| k == "robots") {
            if let Some((_, v)) = map.iter_mut().find(|(k, _)| k == origin) {
                *v = entry;
            } else {
                map.push((origin.into(), entry));
            }
            return;
        }
        pairs.push((
            "robots".into(),
            Json::Obj(alloc::vec![(origin.into(), entry)]),
        ));
    }
}

pub(crate) fn sitemap_seeded(state: &Json, origin: &str) -> bool {
    if let Some(Json::Arr(items)) = state.get("sitemapSeeded") {
        for item in items {
            if item.as_str() == Some(origin) {
                return true;
            }
        }
    }
    false
}

pub(crate) fn mark_sitemap_seeded(state: &mut Json, origin: &str) {
    if sitemap_seeded(state, origin) {
        return;
    }
    if let Json::Obj(ref mut pairs) = state {
        if let Some((_, Json::Arr(items))) = pairs.iter_mut().find(|(k, _)| k == "sitemapSeeded") {
            items.push(Json::Str(origin.into()));
            return;
        }
        pairs.push((
            "sitemapSeeded".into(),
            Json::Arr(alloc::vec![Json::Str(origin.into())]),
        ));
    }
}
