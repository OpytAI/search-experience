//! Global allocator for the no_std searchd guest.
//!
//! AgentOS resident services use talc's Wasm-dynamic allocator (grows with
//! memory.grow). Do **not** use a multi-MiB static BSS bump — that forces a
//! huge Wasm `initial` memory (previously 32 MiB → 529 pages) which lands in
//! the MCSN full snapshot as mostly zero pages.

#[global_allocator]
static ALLOCATOR: talc::wasm::WasmDynamicTalc = talc::wasm::new_wasm_dynamic_allocator();
