-- searchd guest authority (protocol v1)
-- Same JSON envelope as /svc/searchd. Host prefers vm.serviceCall("searchd", bytes);
-- until a stamped binary is in search-atlas, the runtime installs this module and
-- dispatches via a thin transport that does not implement crawl/rank on the host.
--
-- State lives under /var/searchd (product-canonical guest path; not
-- /var/lib/agentos-search). Survives whole-machine snapshots.
--
-- Active index:  /var/searchd/index.db     (queries always read this)
-- Candidate:     /var/searchd/candidate.db (refresh writes here; promote swaps)

local json = require("json")
local sqlite = require("sqlite")

local STATE_DIR = "/var/searchd"
local INDEX_PATH = STATE_DIR .. "/index.db"
local CANDIDATE_PATH = STATE_DIR .. "/candidate.db"
local META_PATH = STATE_DIR .. "/state.json"
local REQ_PATH = STATE_DIR .. "/request.json"
local RESP_PATH = STATE_DIR .. "/response.json"

local FETCH_ADDR = "host.org.main.search.fetch"
local EXTRACT_ADDR = "host.org.main.search.extract"
local EMBED_ADDR = "host.org.main.search.embed.batch"

local function ensure_dir()
  sys.fs.mkdir(STATE_DIR, true)
end

local function read_json(path)
  local ok, data = pcall(function()
    return sys.fs.read(path)
  end)
  if not ok or not data or data == "" then
    return nil
  end
  return json.decode(data)
end

local function write_json(path, value)
  sys.fs.write(path, json.encode(value))
end

local function load_state()
  return read_json(META_PATH) or {
    phase = "unconfigured",
    lexicalReady = false,
    semanticReady = false,
    collections = {},
    queue = {},
    visited = {},
    fingerprints = {},
    robots = {},
    sitemapsSeen = {},
    embedCursor = 0,
    generation = "gen-1",
    candidateGeneration = nil,
    pages = 0,
    chunks = 0,
    embeddedChunks = 0,
    modelFingerprint = "",
    compatibilityKey = "",
    pageOrigin = "",
    error = nil,
    embedError = nil,
  }
end

local function save_state(state)
  write_json(META_PATH, state)
end

local function ok_resp(id, op, extra)
  local r = { v = 1, id = id, ok = true, op = op }
  if extra then
    for k, v in pairs(extra) do
      r[k] = v
    end
  end
  return r
end

local function err_resp(id, code, message)
  return { v = 1, id = id, ok = false, code = code, error = message }
end

local function open_db(path, mode)
  local db = assert(sqlite.open(path or INDEX_PATH, { mode = mode or "rwc" }))
  pcall(function()
    db:exec("PRAGMA foreign_keys = ON")
  end)
  return db
end

local function set_meta(db, key, value)
  db:exec(
    "INSERT INTO search_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    tostring(value)
  )
end

local function status_body(state)
  local caps = {}
  for _, c in ipairs(state.collections or {}) do
    local capabilities = { "lexical" }
    if state.semanticReady then
      table.insert(capabilities, "semantic")
      table.insert(capabilities, "hybrid")
    end
    table.insert(caps, {
      id = c.id,
      label = c.label,
      order = c.order or 10,
      minQueryLength = c.minQueryLength or 1,
      limit = c.limit or 10,
      prefix = c.prefix,
      placeholder = c.placeholder,
      emptyStateLabel = c.emptyStateLabel,
      language = c.language,
      builtAt = state.builtAt,
      truncated = state.truncated,
      capabilities = capabilities,
      pages = c.pageCount or 0,
      chunks = c.chunkCount or 0,
    })
  end
  local message = state.message
  if state.embedError and not state.semanticReady then
    message = (message and (message .. " ") or "") .. state.embedError
  end
  return {
    phase = state.phase,
    message = message,
    compatibilityKey = state.compatibilityKey,
    activeGeneration = state.generation,
    candidateGeneration = state.candidateGeneration,
    lexicalReady = state.lexicalReady == true,
    semanticReady = state.semanticReady == true,
    collections = caps,
    pages = state.pages or 0,
    chunks = state.chunks or 0,
    embeddedChunks = state.embeddedChunks or 0,
    queueDepth = #(state.queue or {}),
    error = state.error,
    truncated = state.truncated,
  }
end

local function call_tool(address, args)
  local tools = require("tools")
  local res = tools.call(address, args)
  if type(res) ~= "table" then
    error("tool " .. address .. " returned non-table")
  end
  if res.ok == false then
    local msg = (res.err and res.err.message) or "tool failed"
    error(msg)
  end
  return res.data
end

local function canonicalize(url)
  local bare = string.gsub(url, "#.*$", "")
  if string.match(bare, "^https?://[^/]+/$") then
    return bare
  end
  bare = string.gsub(bare, "/$", "")
  return bare
end

local function origin_of(url)
  return string.match(url, "^(https?://[^/]+)")
end

local function path_of(url)
  return string.match(url, "^https?://[^/]+(/.*)$") or "/"
end

local function is_http_url(url)
  return type(url) == "string" and string.match(url, "^https?://") ~= nil
end

local function accepts_url(state, collection, url)
  if not is_http_url(url) then
    return false
  end
  local origins = collection.origins or {}
  if #origins > 0 then
    local allowed = false
    for _, origin in ipairs(origins) do
      if string.sub(url, 1, #origin) == origin then
        allowed = true
        break
      end
    end
    if not allowed then
      return false
    end
  elseif state.pageOrigin and state.pageOrigin ~= "" then
    if string.sub(url, 1, #state.pageOrigin) ~= state.pageOrigin then
      return false
    end
  end
  local path = path_of(url)
  if collection.includePathPrefixes and #collection.includePathPrefixes > 0 then
    local hit = false
    for _, prefix in ipairs(collection.includePathPrefixes) do
      if string.sub(path, 1, #prefix) == prefix then
        hit = true
        break
      end
    end
    if not hit then
      return false
    end
  end
  if collection.excludePathPrefixes then
    for _, prefix in ipairs(collection.excludePathPrefixes) do
      if string.sub(path, 1, #prefix) == prefix then
        return false
      end
    end
  end
  return true
end

-- robots.txt: parse UA groups correctly (no Disallow bleed across groups).
-- Consecutive User-agent lines share a group; rules apply until the next group.
local function parse_robots(body, user_agent)
  local ua_lower = string.lower(user_agent or "")
  local groups = {}
  local current = nil
  local function flush()
    if current then
      table.insert(groups, current)
      current = nil
    end
  end
  for line in string.gmatch((body or "") .. "\n", "(.-)\n") do
    line = string.gsub(line, "#.*$", "")
    line = string.gsub(line, "^%s+", "")
    line = string.gsub(line, "%s+$", "")
    if line ~= "" then
      local ua = string.match(line, "^[Uu]ser%-[Aa]gent:%s*(.+)$")
      if ua then
        ua = string.lower(string.gsub(ua, "%s+$", ""))
        -- Start a new group if the current one already has rules.
        if current and current.has_rules then
          flush()
        end
        if not current then
          current = { agents = {}, disallow = {}, sitemap = {}, has_rules = false }
        end
        table.insert(current.agents, ua)
      elseif current then
        local dis = string.match(line, "^[Dd]isallow:%s*(.*)$")
        if dis then
          current.has_rules = true
          dis = string.gsub(dis, "%s+$", "")
          if dis ~= "" then
            table.insert(current.disallow, dis)
          end
        end
        local sm = string.match(line, "^[Ss]itemap:%s*(%S+)")
        if sm then
          table.insert(current.sitemap, sm)
        end
      else
        -- Sitemap outside a group still recorded via a synthetic * group later.
        local sm = string.match(line, "^[Ss]itemap:%s*(%S+)")
        if sm then
          current = { agents = { "*" }, disallow = {}, sitemap = { sm }, has_rules = false }
        end
      end
    end
  end
  flush()

  local function group_matches(group, exact_star)
    for _, agent in ipairs(group.agents) do
      if exact_star then
        if agent == "*" then
          return true
        end
      else
        if agent ~= "*" and string.find(ua_lower, agent, 1, true) then
          return true
        end
      end
    end
    return false
  end

  local chosen = nil
  for _, group in ipairs(groups) do
    if group_matches(group, false) then
      chosen = group
      break
    end
  end
  if not chosen then
    for _, group in ipairs(groups) do
      if group_matches(group, true) then
        chosen = group
        break
      end
    end
  end
  if not chosen then
    return { disallow = {}, sitemap = {} }
  end
  return { disallow = chosen.disallow, sitemap = chosen.sitemap }
end

local function robots_allows(rules, path)
  if not rules or not rules.disallow then
    return true
  end
  for _, prefix in ipairs(rules.disallow) do
    if prefix == "/" then
      return false
    end
    if string.sub(path, 1, #prefix) == prefix then
      return false
    end
  end
  return true
end

local function ensure_robots(state, origin, collection)
  state.robots = state.robots or {}
  if state.robots[origin] then
    return state.robots[origin]
  end
  local ua = "AgentOSSearch/1.0"
  local ok, fetched = pcall(function()
    return call_tool(FETCH_ADDR, {
      url = origin .. "/robots.txt",
      maxBytes = 256000,
      timeoutMs = collection.timeoutMs or 15000,
      userAgent = ua,
    })
  end)
  local rules
  if ok and fetched and fetched.status and fetched.status >= 200 and fetched.status < 300 then
    rules = parse_robots(fetched.body or "", ua)
  elseif ok and fetched and fetched.status and (fetched.status == 404 or fetched.status == 410) then
    -- Missing robots.txt: allow-all is standard.
    rules = { disallow = {} }
  else
    -- Transport / non-404 failure: deny-by-default for this origin.
    rules = { disallow = { "/" }, deny_all = true }
  end
  state.robots[origin] = rules
  return rules
end

-- Forever dual-DB contract:
--   queries  → always INDEX_PATH (stable active generation)
--   refresh  → always writes CANDIDATE_PATH (never the active file)
--   promote  → copy candidate bytes over INDEX_PATH, then wipe candidate
local function write_path(state)
  if state.writeCandidate then
    return CANDIDATE_PATH
  end
  return INDEX_PATH
end

local function query_path(_state)
  return INDEX_PATH
end

local function copy_file(from_path, to_path)
  local ok, data = pcall(function()
    return sys.fs.read(from_path)
  end)
  if not ok or data == nil or data == "" then
    return false
  end
  local wok = pcall(function()
    sys.fs.write(to_path, data)
  end)
  return wok == true
end

local function wipe_candidate_db()
  pcall(function()
    -- Best-effort: overwrite with empty so next refresh starts clean.
    sys.fs.write(CANDIDATE_PATH, "")
  end)
end

local function enqueue(state, collection, url)
  if not is_http_url(url) then
    return
  end
  local canon = canonicalize(url)
  if state.visited[canon] then
    return
  end
  if not accepts_url(state, collection, canon) then
    return
  end
  local origin = origin_of(canon)
  if origin then
    local rules = ensure_robots(state, origin, collection)
    if not robots_allows(rules, path_of(canon)) then
      state.visited[canon] = "robots"
      return
    end
  end
  local maxQueue = collection.maxQueue or 2000
  if #(state.queue) >= maxQueue then
    state.truncated = true
    return
  end
  table.insert(state.queue, { url = canon, collectionId = collection.id })
  state.visited[canon] = "queued"
end

local function enqueue_sitemaps(state, collection)
  local maxSitemaps = collection.maxSitemaps or 10
  state.sitemapsSeen = state.sitemapsSeen or {}
  local seeds = {}
  for _, seed in ipairs(collection.seeds or {}) do
    local origin = origin_of(seed)
    if origin then
      table.insert(seeds, origin .. "/sitemap.xml")
      local rules = ensure_robots(state, origin, collection)
      if rules.sitemap then
        for _, sm in ipairs(rules.sitemap) do
          table.insert(seeds, sm)
        end
      end
    end
  end
  local count = 0
  for _, smUrl in ipairs(seeds) do
    if count >= maxSitemaps then
      break
    end
    if not state.sitemapsSeen[smUrl] then
      state.sitemapsSeen[smUrl] = true
      count = count + 1
      local ok, fetched = pcall(function()
        return call_tool(FETCH_ADDR, {
          url = smUrl,
          maxBytes = 2e6,
          timeoutMs = collection.timeoutMs or 15000,
        })
      end)
      if ok and fetched and fetched.status and fetched.status >= 200 and fetched.status < 300 then
        local body = fetched.body or ""
        for loc in string.gmatch(body, "<loc[^>]*>([^<]+)</loc>") do
          loc = string.gsub(loc, "&amp;", "&")
          loc = string.gsub(loc, "^%s+", "")
          loc = string.gsub(loc, "%s+$", "")
          if string.find(loc, "sitemap", 1, true) and count < maxSitemaps then
            if not state.sitemapsSeen[loc] then
              table.insert(seeds, loc)
            end
          else
            enqueue(state, collection, loc)
          end
        end
      end
    end
  end
end

local function apply_schema(db, schemaSql)
  for statement in string.gmatch(schemaSql .. "\n", "(.-);\n") do
    local sql = string.gsub(statement, "^%s+", "")
    sql = string.gsub(sql, "%s+$", "")
    if sql ~= "" and not string.match(sql, "^%-%-") then
      pcall(function()
        db:exec(sql)
      end)
    end
  end
end

local function content_hash(text)
  local h = 2166136261
  for i = 1, #text do
    h = bit32.bxor(h, string.byte(text, i))
    h = (h * 16777619) % 4294967296
  end
  return string.format("%08x%08x", h, #text)
end

local function chunk_blocks(page, maxChars)
  maxChars = maxChars or 1200
  local chunks = {}
  local ordinal = 0
  for _, block in ipairs(page.blocks or {}) do
    local text = block.text or ""
    if #text > 0 then
      local start = 1
      while start <= #text do
        local finish = math.min(#text, start + maxChars - 1)
        if finish < #text then
          local space = string.find(string.reverse(string.sub(text, start, finish)), "%s")
          if space and space < 200 then
            finish = finish - space + 1
          end
        end
        local body = string.sub(text, start, finish)
        ordinal = ordinal + 1
        table.insert(chunks, {
          ordinal = ordinal,
          heading = block.heading or "",
          body = body,
        })
        start = finish + 1
      end
    end
  end
  if #chunks == 0 and (page.description or "") ~= "" then
    table.insert(chunks, { ordinal = 1, heading = "", body = page.description })
  end
  return chunks
end

local function upsert_collection_row(db, collection)
  local now = os.date("!%Y-%m-%dT%H:%M:%SZ")
  db:exec(
    [[INSERT INTO collections(id, label, source_json, page_count, chunk_count, built_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        source_json = excluded.source_json,
        page_count = excluded.page_count,
        chunk_count = excluded.chunk_count,
        built_at = excluded.built_at]],
    collection.id,
    collection.label,
    json.encode({
      seeds = collection.seeds,
      origins = collection.origins,
      includePathPrefixes = collection.includePathPrefixes,
      excludePathPrefixes = collection.excludePathPrefixes,
    }),
    collection.pageCount or 0,
    collection.chunkCount or 0,
    now
  )
end

local function index_page(state, collection, page)
  if not is_http_url(page.canonicalUrl or "") and not is_http_url(page.requestedUrl or "") then
    return 0
  end
  local dbPath = write_path(state)
  local db = open_db(dbPath, "rwc")
  local now = os.time()
  local hash = content_hash((page.title or "") .. "\n" .. (page.description or "") .. "\n" .. json.encode(page.blocks or {}))
  local stablePage = collection.id .. ":" .. (page.canonicalUrl or page.requestedUrl)
  -- During candidate build use candidate fingerprints; active queries keep using active DB.
  local fpKey = (state.candidateGeneration and state.writeCandidate and ("c:" .. stablePage)) or stablePage
  local fps = state.fingerprints or {}
  if fps[fpKey] == hash then
    db:close()
    return 0
  end

  -- Drop prior chunks/vectors for this page before re-insert (avoid chunk_vec orphans).
  local old = db:queryone("SELECT id FROM pages WHERE stable_id = ?", stablePage)
  if old and old.id then
    pcall(function()
      local oldChunks = db:query("SELECT id FROM chunks WHERE page_id = ?", old.id)
      for _, row in ipairs(oldChunks or {}) do
        pcall(function()
          db:exec("DELETE FROM chunk_vec WHERE rowid = ?", row.id)
        end)
      end
    end)
  end
  db:exec("DELETE FROM pages WHERE stable_id = ?", stablePage)
  db:exec(
    [[INSERT INTO pages(stable_id, collection_id, url, canonical_url, title, description, language, content_hash, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)]],
    stablePage,
    collection.id,
    page.requestedUrl or page.canonicalUrl,
    page.canonicalUrl or page.requestedUrl,
    page.title or "",
    page.description or "",
    page.language or "",
    hash,
    now
  )
  local pageRow = db:queryone("SELECT id FROM pages WHERE stable_id = ?", stablePage)
  local pageId = pageRow.id
  local chunks = chunk_blocks(page)
  for _, chunk in ipairs(chunks) do
    local stableChunk = stablePage .. "#" .. tostring(chunk.ordinal)
    db:exec(
      [[INSERT INTO chunks(stable_id, collection_id, page_id, ordinal, url, title, heading, body, content_hash, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)]],
      stableChunk,
      collection.id,
      pageId,
      chunk.ordinal,
      page.canonicalUrl or page.requestedUrl,
      page.title or "",
      chunk.heading,
      chunk.body,
      content_hash(chunk.body),
      "{}"
    )
  end
  local nchunks = #chunks
  if state.writeCandidate then
    state.candidatePages = (state.candidatePages or 0) + 1
    state.candidateChunks = (state.candidateChunks or 0) + nchunks
    collection.candidatePageCount = (collection.candidatePageCount or 0) + 1
  else
    state.pages = (state.pages or 0) + 1
    state.chunks = (state.chunks or 0) + nchunks
    collection.pageCount = (collection.pageCount or 0) + 1
    collection.chunkCount = (collection.chunkCount or 0) + nchunks
  end
  state.fingerprints = state.fingerprints or {}
  state.fingerprints[fpKey] = hash
  upsert_collection_row(db, collection)
  set_meta(db, "model_fingerprint", state.modelFingerprint or "")
  set_meta(db, "generation", state.candidateGeneration or state.generation or "gen-1")
  db:close()
  return #chunks
end

local function find_collection(state, id)
  for _, c in ipairs(state.collections or {}) do
    if c.id == id then
      return c
    end
  end
  return nil
end

local function build_fts_query(input)
  local terms = {}
  local seen = {}
  local lowered = string.lower(input)
  for token in string.gmatch(lowered, "[%w_][%w_%-]*") do
    if not seen[token] and #terms < 16 then
      seen[token] = true
      local escaped = string.gsub(token, '"', '""')
      table.insert(terms, '"' .. escaped .. '"*')
    end
  end
  return table.concat(terms, " AND ")
end

local function collection_from_def(def)
  return {
    id = def.id,
    label = def.label,
    order = def.order or 10,
    seeds = def.seeds or {},
    origins = def.origins or {},
    includePathPrefixes = def.includePathPrefixes,
    excludePathPrefixes = def.excludePathPrefixes,
    maxPages = def.maxPages or 100,
    maxQueue = def.maxQueue or 500,
    maxPageBytes = def.maxPageBytes or 2000000,
    maxSitemaps = def.maxSitemaps or 10,
    timeoutMs = def.timeoutMs or 15000,
    minQueryLength = def.minQueryLength or 1,
    limit = def.limit or 10,
    prefix = def.prefix,
    placeholder = def.placeholder,
    emptyStateLabel = def.emptyStateLabel,
    language = def.language,
    pageCount = 0,
    chunkCount = 0,
  }
end

local function handle_configure(req)
  ensure_dir()
  local state = load_state()
  local config = req.config or {}
  local resume = config.resume == true
  local sameKey = (config.compatibilityKey or "") ~= ""
    and state.compatibilityKey == config.compatibilityKey
  local canResume = resume and sameKey and state.lexicalReady == true

  if canResume then
    -- Warm restore path: keep index, queues, fingerprints; only refresh metadata.
    state.modelFingerprint = config.modelFingerprint or state.modelFingerprint
    state.pageOrigin = config.pageOrigin or state.pageOrigin
    state.schemaSql = config.schemaSql or state.schemaSql
    state.writeCandidate = false
    state.candidateGeneration = nil
    state.error = nil
    state.message = "Resumed from warm snapshot"
    if state.semanticReady then
      state.phase = "semantic_ready"
    else
      state.phase = "lexical_ready"
    end
    -- Ensure collection rows exist for FK integrity.
    local db = open_db(query_path(state), "rwc")
    if config.schemaSql and config.schemaSql ~= "" then
      apply_schema(db, config.schemaSql)
    end
    for _, c in ipairs(state.collections or {}) do
      upsert_collection_row(db, c)
    end
    db:close()
    save_state(state)
    return ok_resp(req.id, "configure", { status = status_body(state) })
  end

  -- Cold configure: wipe and rebuild.
  state.phase = "configuring"
  state.compatibilityKey = config.compatibilityKey or ""
  state.modelFingerprint = config.modelFingerprint or ""
  state.pageOrigin = config.pageOrigin or ""
  state.schemaSql = config.schemaSql or ""
  state.collections = {}
  state.queue = {}
  state.visited = {}
  state.fingerprints = {}
  state.robots = {}
  state.sitemapsSeen = {}
  state.embedCursor = 0
  state.pages = 0
  state.chunks = 0
  state.embeddedChunks = 0
  state.generation = "gen-1"
  state.candidateGeneration = nil
  state.writeCandidate = false
  state.lexicalReady = false
  state.semanticReady = false
  state.error = nil
  state.embedError = nil
  state.message = "Configured"

  local schemaSql = config.schemaSql or ""
  wipe_candidate_db()
  local db = open_db(INDEX_PATH, "rwc")
  if schemaSql ~= "" then
    apply_schema(db, schemaSql)
  end

  for _, def in ipairs(config.collections or {}) do
    local collection = collection_from_def(def)
    table.insert(state.collections, collection)
    upsert_collection_row(db, collection)
    for _, seed in ipairs(collection.seeds) do
      enqueue(state, collection, seed)
    end
    enqueue_sitemaps(state, collection)
  end
  db:close()
  state.phase = "crawling"
  state.message = "Crawl queued"
  save_state(state)
  return ok_resp(req.id, "configure", { status = status_body(state) })
end

local function handle_status(req)
  local state = load_state()
  return ok_resp(req.id, "status", { status = status_body(state) })
end

local function handle_refresh(req)
  local state = load_state()
  if not state.lexicalReady then
    return err_resp(req.id, "not_ready", "cannot refresh before lexical ready")
  end
  if state.writeCandidate then
    return err_resp(req.id, "busy", "candidate refresh already in progress")
  end
  -- Every refresh cycle: write ONLY to CANDIDATE_PATH; queries stay on INDEX_PATH.
  wipe_candidate_db()
  local cand = "cand-" .. tostring(os.time())
  state.candidateGeneration = cand
  state.writeCandidate = true
  state.phase = "refreshing"
  state.message = "Refreshing candidate generation"
  state.queue = {}
  state.visited = {}
  state.robots = {}
  state.sitemapsSeen = {}
  state.candidatePages = 0
  state.candidateChunks = 0
  state.embedError = nil
  -- Keep active semanticReady — queries keep using INDEX_PATH.
  local schemaSql = state.schemaSql or ""
  local cdb = open_db(CANDIDATE_PATH, "rwc")
  if schemaSql ~= "" then
    apply_schema(cdb, schemaSql)
  end
  for _, collection in ipairs(state.collections or {}) do
    collection.candidatePageCount = 0
    upsert_collection_row(cdb, collection)
    for _, seed in ipairs(collection.seeds or {}) do
      enqueue(state, collection, seed)
    end
    enqueue_sitemaps(state, collection)
  end
  cdb:close()
  save_state(state)
  return ok_resp(req.id, "refresh", { status = status_body(state) })
end

local function discard_candidate(state, reason)
  state.candidateGeneration = nil
  state.writeCandidate = false
  state.candidatePages = 0
  wipe_candidate_db()
  state.phase = state.semanticReady and "semantic_ready" or "lexical_ready"
  state.message = reason or "Candidate discarded"
end

local function promote_candidate(state)
  -- Validate before swapping: complete non-empty lexical candidate only.
  if not state.candidateGeneration or not state.writeCandidate then
    return false
  end
  local pages = state.candidatePages or 0
  local chunks = state.candidateChunks or 0
  if pages < 1 or chunks < 1 then
    discard_candidate(state, "Candidate discarded: incomplete (need pages and chunks)")
    return false
  end
  if state.truncated then
    discard_candidate(state, "Candidate discarded: truncated crawl")
    return false
  end
  -- Copy candidate → INDEX_PATH so queries always hit the stable active path forever.
  if not copy_file(CANDIDATE_PATH, INDEX_PATH) then
    discard_candidate(state, "Candidate discarded: promote copy failed")
    return false
  end
  state.generation = state.candidateGeneration
  state.candidateGeneration = nil
  state.writeCandidate = false
  state.pages = pages
  state.chunks = chunks
  state.lexicalReady = true
  -- Semantic must be rebuilt against the new active file.
  state.semanticReady = false
  state.embedCursor = 0
  state.embeddedChunks = 0
  state.candidatePages = 0
  state.candidateChunks = 0
  state.message = "Candidate promoted"
  wipe_candidate_db()
  for _, collection in ipairs(state.collections or {}) do
    if collection.candidatePageCount then
      collection.pageCount = collection.candidatePageCount
      collection.candidatePageCount = 0
    end
  end
  return true
end

local function handle_crawl_step(req)
  local state = load_state()
  if state.phase == "unconfigured" then
    return err_resp(req.id, "not_configured", "call configure first")
  end
  local maxFetches = req.maxFetches or 4
  local fetches = 0
  local indexedPages = 0
  local indexedChunks = 0

  while fetches < maxFetches and #(state.queue) > 0 do
    local item = table.remove(state.queue, 1)
    local collection = find_collection(state, item.collectionId)
    if not collection then
      break
    end
    -- Enforce maxPages for both active crawl and candidate refresh builds.
    local usedPages = state.writeCandidate and (collection.candidatePageCount or 0) or (collection.pageCount or 0)
    if usedPages >= (collection.maxPages or 100) then
      state.visited[item.url] = "skipped"
    else
      fetches = fetches + 1
      state.visited[item.url] = "fetching"
      local ok, fetched = pcall(function()
        return call_tool(FETCH_ADDR, {
          url = item.url,
          maxBytes = collection.maxPageBytes,
          timeoutMs = collection.timeoutMs,
        })
      end)
      if not ok or not fetched then
        state.visited[item.url] = "error"
      elseif fetched.status and fetched.status >= 400 then
        state.visited[item.url] = "http_error"
      else
        local contentType = string.lower(fetched.contentType or "")
        if not string.find(contentType, "html") and fetched.body and not string.find(string.sub(fetched.body, 1, 200), "<html") then
          state.visited[item.url] = "skipped_type"
        else
          local eok, extracted = pcall(function()
            return call_tool(EXTRACT_ADDR, { url = fetched.finalUrl or item.url, html = fetched.body or "" })
          end)
          if eok and extracted and not extracted.noindex then
            for _, link in ipairs(extracted.links or {}) do
              enqueue(state, collection, link)
            end
            local n = index_page(state, collection, extracted)
            indexedPages = indexedPages + 1
            indexedChunks = indexedChunks + n
            state.visited[item.url] = "indexed"
          else
            state.visited[item.url] = "extract_error"
          end
        end
      end
    end
  end

  local done = #(state.queue) == 0
  if done or (state.pages or 0) > 0 or (state.candidatePages or 0) > 0 then
    -- Active generation stays lexical-ready during candidate crawl.
    if not state.writeCandidate then
      state.lexicalReady = true
    end
    if done then
      if state.writeCandidate then
        local ok = promote_candidate(state)
        if ok then
          state.phase = "lexical_ready"
          state.message = "Candidate promoted; lexical ready"
        end
        -- discard_candidate already set phase/message on failure
      elseif state.semanticReady then
        state.phase = "semantic_ready"
      else
        state.phase = "lexical_ready"
        state.message = "Lexical index ready"
      end
    else
      if state.writeCandidate then
        state.phase = "refreshing"
        state.message = "Refreshing candidate…"
      else
        state.phase = "crawling"
        state.message = "Crawling…"
      end
    end
  end
  state.builtAt = os.date("!%Y-%m-%dT%H:%M:%SZ")
  save_state(state)
  return ok_resp(req.id, "crawl_step", {
    status = status_body(state),
    progress = {
      fetches = fetches,
      indexedPages = indexedPages,
      indexedChunks = indexedChunks,
      queueDepth = #(state.queue),
      done = done,
    },
  })
end

local function handle_embed_step(req)
  local state = load_state()
  if not state.lexicalReady then
    return err_resp(req.id, "not_ready", "lexical index not ready")
  end
  -- Never embed into a half-built candidate; only the active query path.
  if state.writeCandidate then
    return err_resp(req.id, "busy", "candidate refresh in progress")
  end
  local maxChunks = req.maxChunks or 8
  local db = open_db(query_path(state), "rw")
  local rows = db:query(
    [[SELECT id, title, heading, body FROM chunks WHERE id > ? ORDER BY id LIMIT ?]],
    state.embedCursor or 0,
    maxChunks
  )
  if #rows == 0 then
    state.semanticReady = true
    state.phase = "semantic_ready"
    state.message = "Semantic index ready"
    state.embedError = nil
    save_state(state)
    db:close()
    return ok_resp(req.id, "embed_step", {
      status = status_body(state),
      progress = { embeddedChunks = 0, done = true },
    })
  end

  local texts = {}
  for _, row in ipairs(rows) do
    local parts = {}
    if row.title and row.title ~= "" then
      table.insert(parts, row.title)
    end
    if row.heading and row.heading ~= "" then
      table.insert(parts, row.heading)
    end
    if row.body and row.body ~= "" then
      table.insert(parts, row.body)
    end
    table.insert(texts, table.concat(parts, "\n"))
  end

  local ok, embedded = pcall(function()
    return call_tool(EMBED_ADDR, { texts = texts, kind = "document" })
  end)
  if not ok or not embedded or not embedded.vectors then
    db:close()
    state.semanticReady = false
    state.phase = "lexical_ready"
    state.embedError = "Semantic embedding unavailable; lexical search remains active"
    state.message = "Lexical index ready"
    save_state(state)
    return ok_resp(req.id, "embed_step", {
      status = status_body(state),
      progress = { embeddedChunks = 0, done = true },
    })
  end

  local now = os.time()
  for i, row in ipairs(rows) do
    local vector = embedded.vectors[i]
    if vector then
      pcall(function()
        db:exec(
          [[INSERT INTO chunk_vec(rowid, embedding, collection_id, page_id, updated_at)
            SELECT id, ?, collection_id, page_id, ? FROM chunks WHERE id = ?]],
          vector,
          now,
          row.id
        )
      end)
      pcall(function()
        if db.vectorInsert then
          local meta = db:queryone("SELECT collection_id, page_id FROM chunks WHERE id = ?", row.id)
          db:vectorInsert("chunk_vec", row.id, vector, {
            collection_id = meta.collection_id,
            page_id = meta.page_id,
            updated_at = now,
          })
        end
      end)
      state.embeddedChunks = (state.embeddedChunks or 0) + 1
      state.embedCursor = row.id
    end
  end
  set_meta(db, "model_fingerprint", state.modelFingerprint or "")
  db:close()

  local done = #rows < maxChunks
  if done then
    state.semanticReady = true
    state.phase = "semantic_ready"
    state.message = "Semantic index ready"
    state.embedError = nil
  else
    state.phase = "embedding"
    state.message = "Embedding documents…"
  end
  save_state(state)
  return ok_resp(req.id, "embed_step", {
    status = status_body(state),
    progress = {
      embeddedChunks = #rows,
      done = done,
    },
  })
end

local function handle_query(req)
  local state = load_state()
  if not state.lexicalReady then
    return ok_resp(req.id, "query", {
      status = status_body(state),
      hits = {},
      semanticAvailable = false,
    })
  end
  local limit = req.limit or 10
  local candidateLimit = req.candidateLimit or 40
  local perPageLimit = req.perPageLimit or 2
  local rrfK = req.rrfK or 60
  local ftsQuery = build_fts_query(req.query or "")
  local collectionId = req.collectionId
  -- Always query the stable active generation (never a half-built candidate).
  local db = open_db(query_path(state), "ro")
  local candidates = {}

  local function cand(rowid)
    local key = tostring(rowid)
    if not candidates[key] then
      candidates[key] = { rowid = rowid, fused = 0 }
    end
    return candidates[key]
  end

  if ftsQuery ~= "" then
    local lexical = db:query(
      [[SELECT c.id AS rowid, c.stable_id, c.page_id, c.collection_id, c.url, c.title, c.heading, c.body,
               bm25(chunks_fts, 8.0, 4.0, 1.0, 0.0) AS lexical_score,
               snippet(chunks_fts, 2, '', '', '…', 24) AS snippet
        FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ? AND c.collection_id = ?
        ORDER BY lexical_score, c.id LIMIT ?]],
      ftsQuery,
      collectionId,
      candidateLimit
    )
    for rank, row in ipairs(lexical) do
      local c = cand(row.rowid)
      c.lexical_rank = rank
      c.lexical_score = row.lexical_score
      c.snippet = row.snippet
      c.stable_id = row.stable_id
      c.page_id = row.page_id
      c.collection_id = row.collection_id
      c.url = row.url
      c.title = row.title
      c.heading = row.heading
      c.body = row.body
      c.fused = c.fused + 1 / (rrfK + rank)
    end
  end

  -- Guest owns query embedding when semantic is ready (host must not pre-inject).
  local queryVector = req.queryVector
  if (not queryVector or #queryVector == 0) and state.semanticReady and req.query and req.query ~= "" then
    local eok, embedded = pcall(function()
      return call_tool(EMBED_ADDR, { texts = { req.query }, kind = "query" })
    end)
    if eok and embedded and embedded.vectors and embedded.vectors[1] then
      queryVector = embedded.vectors[1]
    end
  end

  local semanticAvailable = false
  if queryVector and state.semanticReady then
    local ok, semantic = pcall(function()
      return db:vectorSearch("chunk_vec", queryVector, {
        vector = "embedding",
        type = "f32",
        k = candidateLimit,
        partition = { collection_id = collectionId },
      })
    end)
    if ok and semantic then
      semanticAvailable = true
      for rank, row in ipairs(semantic) do
        local c = cand(row.rowid)
        c.semantic_rank = rank
        c.semantic_distance = row.distance
        c.fused = c.fused + 1 / (rrfK + rank)
        if not c.stable_id then
          local full = db:queryone(
            "SELECT stable_id, page_id, collection_id, url, title, heading, body FROM chunks WHERE id = ?",
            row.rowid
          )
          if full then
            c.stable_id = full.stable_id
            c.page_id = full.page_id
            c.collection_id = full.collection_id
            c.url = full.url
            c.title = full.title
            c.heading = full.heading
            c.body = full.body
          end
        end
      end
    end
  end

  local ordered = {}
  for _, c in pairs(candidates) do
    if c.stable_id and is_http_url(c.url or "") then
      table.insert(ordered, c)
    end
  end
  table.sort(ordered, function(a, b)
    if a.fused ~= b.fused then
      return a.fused > b.fused
    end
    return tostring(a.stable_id) < tostring(b.stable_id)
  end)

  local hits = {}
  local perPage = {}
  for _, row in ipairs(ordered) do
    local pk = tostring(row.page_id)
    local used = perPage[pk] or 0
    if used < perPageLimit and #hits < limit then
      perPage[pk] = used + 1
      table.insert(hits, {
        id = row.stable_id,
        collectionId = row.collection_id,
        pageId = row.page_id,
        url = row.url,
        title = row.title or "",
        heading = row.heading,
        snippet = row.snippet or row.heading or string.sub(row.body or "", 1, 160),
        body = row.body,
        score = row.fused,
        lexicalRank = row.lexical_rank,
        semanticRank = row.semantic_rank,
        fusedRank = #hits + 1,
      })
    end
  end
  db:close()
  return ok_resp(req.id, "query", {
    status = status_body(state),
    hits = hits,
    semanticAvailable = semanticAvailable,
  })
end

local function handle_checkpoint(req)
  local state = load_state()
  local kind = req.kind or (state.semanticReady and "semantic" or (state.lexicalReady and "lexical" or "idle"))
  state.lastCheckpoint = { kind = kind, at = os.date("!%Y-%m-%dT%H:%M:%SZ") }
  save_state(state)
  return ok_resp(req.id, "checkpoint", {
    status = status_body(state),
    checkpoint = state.lastCheckpoint,
  })
end

local function handle_promote(req)
  local state = load_state()
  state.generation = req.generationId or state.generation
  state.candidateGeneration = nil
  save_state(state)
  return ok_resp(req.id, "promote", {
    status = status_body(state),
    promoted = { generationId = state.generation },
  })
end

local function handle_cancel(req)
  return ok_resp(req.id, "cancel", {})
end

local function dispatch(req)
  if type(req) ~= "table" or req.v ~= 1 or type(req.op) ~= "string" then
    return err_resp(tostring(req and req.id or "unknown"), "bad_request", "invalid searchd request")
  end
  local handlers = {
    configure = handle_configure,
    status = handle_status,
    crawl_step = handle_crawl_step,
    embed_step = handle_embed_step,
    query = handle_query,
    checkpoint = handle_checkpoint,
    promote = handle_promote,
    refresh = handle_refresh,
    cancel = handle_cancel,
  }
  local handler = handlers[req.op]
  if not handler then
    return err_resp(req.id, "unknown_op", "unknown op " .. tostring(req.op))
  end
  local ok, result = pcall(handler, req)
  if not ok then
    return err_resp(req.id, "internal", tostring(result))
  end
  return result
end

ensure_dir()
local req = read_json(REQ_PATH)
if not req and arg and arg[1] then
  req = json.decode(arg[1])
end
if not req then
  write_json(RESP_PATH, err_resp("none", "no_request", "no request payload"))
  return
end
local response = dispatch(req)
write_json(RESP_PATH, response)
