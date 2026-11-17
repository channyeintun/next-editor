//! The allocator of the native test builds: the system's, counting what each
//! thread asks of it and refusing when told to. A test uses it to show that
//! an operation allocates nothing, to run one with every allocation failing,
//! and to stand for a heap of a given size (`live`).
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static ATTEMPTS: Cell<u64> = const { Cell::new(0) };
    static REFUSING: Cell<bool> = const { Cell::new(false) };
    static LIVE: Cell<usize> = const { Cell::new(0) };
}

pub struct Counting;

/// How many allocations (and growths) this thread has asked for.
pub fn attempts() -> u64 {
    ATTEMPTS.with(Cell::get)
}

/// Makes every allocation and growth of this thread fail, or work again.
pub fn refuse(refusing: bool) {
    REFUSING.with(|flag| flag.set(refusing));
}

/// The bytes this thread holds.
pub fn live() -> usize {
    LIVE.with(Cell::get)
}

fn attempt() -> bool {
    ATTEMPTS.with(|count| count.set(count.get() + 1));
    !REFUSING.with(Cell::get)
}

fn account(added: usize, removed: usize) {
    LIVE.with(|live| live.set(live.get().wrapping_add(added).wrapping_sub(removed)));
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if !attempt() {
            return core::ptr::null_mut();
        }
        account(layout.size(), 0);
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        account(0, layout.size());
        System.dealloc(ptr, layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if new_size > layout.size() && !attempt() {
            return core::ptr::null_mut();
        }
        account(new_size, layout.size());
        System.realloc(ptr, layout, new_size)
    }
}
