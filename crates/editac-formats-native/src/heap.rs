//! Hard ceiling on outstanding Rust allocation requests, including reallocations.
//! This excludes native runtime mappings, stacks and allocator metadata; the host
//! also samples process RSS. Allocation failure aborts the isolated worker, whose
//! host retains the original input and never accepts partial stdout.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
pub const LIMIT: usize = 64 * 1024 * 1024;
pub struct Bounded {
    used: AtomicUsize,
    peak: AtomicUsize,
}
impl Bounded {
    pub const fn new() -> Self {
        Self {
            used: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
        }
    }
    fn reserve(&self, bytes: usize) -> bool {
        let Ok(old) = self
            .used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                n.checked_add(bytes).filter(|v| *v <= LIMIT)
            })
        else {
            return false;
        };
        self.peak.fetch_max(old + bytes, Ordering::SeqCst);
        true
    }
    pub fn peak(&self) -> usize {
        self.peak.load(Ordering::SeqCst)
    }
}
// SAFETY: System owns every pointer. Counters reserve before allocation and roll
// back failed requests. Layouts/pointers are forwarded unchanged. Realloc holds
// the old reservation until success; shrinking releases only after success.
unsafe impl GlobalAlloc for Bounded {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if !self.reserve(layout.size()) {
            return std::ptr::null_mut();
        }
        let p = unsafe { System.alloc(layout) };
        if p.is_null() {
            self.used.fetch_sub(layout.size(), Ordering::SeqCst);
        }
        p
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if !self.reserve(layout.size()) {
            return std::ptr::null_mut();
        }
        let p = unsafe { System.alloc_zeroed(layout) };
        if p.is_null() {
            self.used.fetch_sub(layout.size(), Ordering::SeqCst);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        unsafe { System.dealloc(p, layout) };
        self.used.fetch_sub(layout.size(), Ordering::SeqCst);
    }
    unsafe fn realloc(&self, p: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let growth = size.saturating_sub(layout.size());
        if !self.reserve(growth) {
            return std::ptr::null_mut();
        }
        let next = unsafe { System.realloc(p, layout, size) };
        if next.is_null() {
            self.used.fetch_sub(growth, Ordering::SeqCst);
        } else if size < layout.size() {
            self.used.fetch_sub(layout.size() - size, Ordering::SeqCst);
        }
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allocation_zeroing_growth_shrink_release_and_failed_growth() {
        let a = Bounded::new();
        let layout = Layout::from_size_align(64, 16).unwrap();
        // SAFETY: each pointer is live for its exact original layout; successful
        // realloc transfers ownership and failed realloc preserves the old one.
        unsafe {
            let p = a.alloc_zeroed(layout);
            assert!(!p.is_null());
            assert_eq!(std::slice::from_raw_parts(p, 64), &[0; 64]);
            assert_eq!(a.used.load(Ordering::SeqCst), 64);
            assert!(a.realloc(p, layout, LIMIT + 1).is_null());
            assert_eq!(a.used.load(Ordering::SeqCst), 64);
            *p = 73;
            let p = a.realloc(p, layout, 128);
            assert!(!p.is_null());
            assert_eq!(*p, 73);
            assert_eq!(a.used.load(Ordering::SeqCst), 128);
            let p = a.realloc(p, Layout::from_size_align(128, 16).unwrap(), 16);
            assert!(!p.is_null());
            assert_eq!(*p, 73);
            assert_eq!(a.used.load(Ordering::SeqCst), 16);
            a.dealloc(p, Layout::from_size_align(16, 16).unwrap());
            assert_eq!(a.used.load(Ordering::SeqCst), 0);
            assert_eq!(a.peak(), 128);
        }
        assert!(!a.reserve(usize::MAX));
        assert_eq!(a.used.load(Ordering::SeqCst), 0);
        assert!(a.reserve(LIMIT));
        assert!(!a.reserve(1));
        a.used.fetch_sub(LIMIT, Ordering::SeqCst);
        assert_eq!(a.used.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn concurrent_reservations_and_allocations_share_one_ceiling() {
        let a = Bounded::new();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let a = &a;
                scope.spawn(move || {
                    for _ in 0..1000 {
                        let layout = Layout::from_size_align(1024, 8).unwrap();
                        // SAFETY: each System allocation is freed exactly once with
                        // the same layout and is never aliased to another thread.
                        unsafe {
                            let p = a.alloc(layout);
                            assert!(!p.is_null());
                            a.dealloc(p, layout);
                        }
                    }
                });
            }
        });
        assert_eq!(a.used.load(Ordering::SeqCst), 0);
        assert!(a.peak() <= LIMIT);
    }
}
