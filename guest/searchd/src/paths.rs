//! Guest paths and host tool addresses.

pub(crate) const SERVICE_NAME: &str = "searchd";
pub(crate) const STATE_DIR: &str = "/var/searchd";
pub(crate) const INDEX_PATH: &str = "/var/searchd/index.db";
pub(crate) const CANDIDATE_PATH: &str = "/var/searchd/candidate.db";
pub(crate) const META_PATH: &str = "/var/searchd/state.json";
pub(crate) const FETCH_ADDR: &str = "host.org.main.search.fetch";
pub(crate) const EXTRACT_ADDR: &str = "host.org.main.search.extract";
pub(crate) const EMBED_ADDR: &str = "host.org.main.search.embed.batch";

