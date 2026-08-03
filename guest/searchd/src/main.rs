//! `/svc/searchd` — product site-search authority for search-experience.
//!
//! Resident service that owns crawl/index/query policy. Stitches:
//! - `/svc/sqlite` for FTS5 / VANN
//! - `/svc/tools` for host-backed fetch / extract / embed
//!
//! Wire protocol: JSON envelope v1 (see searchd.protocol.json).

#![no_std]
#![no_main]

extern crate alloc;

mod alloc_heap;
mod paths;
mod jsonx;
mod fsutil;
mod svc;
mod state;
mod handlers;

use alloc::vec::Vec;

use sysroot as rt;

use alloc_heap::BumpAlloc;
use handlers::serve_loop;

#[global_allocator]
static ALLOC: BumpAlloc = BumpAlloc;

rt::entry!(main);

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
