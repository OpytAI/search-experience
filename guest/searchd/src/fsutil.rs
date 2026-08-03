//! Guest filesystem helpers (mc syscalls).

use alloc::vec::Vec;
use sysroot as rt;

// ── fs ───────────────────────────────────────────────────────────────────────

pub(crate) fn ensure_dir() {
    let _ = rt::mkdir("/var");
    let _ = rt::mkdir(crate::paths::STATE_DIR);
}

pub(crate) fn read_file(path: &str) -> Option<Vec<u8>> {
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

pub(crate) fn write_file(path: &str, data: &[u8]) -> bool {
    let flags = rt::O_WRITE | rt::O_CREATE | rt::O_TRUNC;
    let Ok(fd) = rt::open(path, flags) else {
        return false;
    };
    let ok = rt::write_all(fd, data).is_ok();
    let _ = rt::close(fd);
    ok
}

pub(crate) fn read_all_fd(fd: i32) -> Result<Vec<u8>, i32> {
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

