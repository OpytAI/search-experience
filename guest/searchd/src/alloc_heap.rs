//! Bump allocator for the no_std searchd guest.

// ── bump allocator (no external crate dep from product MODULE) ───────────────

pub struct BumpAlloc;

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


