//! The allocator over the shared memory (`chunks.rs` has how it works). Its
//! state lives in a static, which every instance of the module shares; callers
//! hold the filesystem lock, so it is only ever run by one of them at a time.
use core::alloc::{GlobalAlloc, Layout};

mod chunks;
mod memory;
#[cfg(test)]
mod tests;

use chunks::State;
use memory::Memory as _;

/// The allocator over the shared memory.
pub struct Heap;

/// Zero, so that it sits in memory a new module finds already cleared, and so
/// that it is valid before anything has run.
static mut STATE: State = State::ZERO;

unsafe fn state() -> &'static mut State {
    &mut *(&raw mut STATE)
}

#[cfg(target_arch = "wasm32")]
unsafe fn memory() -> &'static mut memory::Linear {
    static mut LINEAR: memory::Linear = memory::Linear;
    &mut *(&raw mut LINEAR)
}

/// Natively the heap is not the global allocator; it runs over an arena so it
/// behaves as it does on wasm32, should anything call it.
#[cfg(not(target_arch = "wasm32"))]
unsafe fn memory() -> &'static mut memory::Arena {
    static mut ARENA: Option<memory::Arena> = None;
    (*(&raw mut ARENA)).get_or_insert_with(|| memory::Arena::new(1 << 30, 0, 0))
}

impl Heap {
    /// Whether the heap's own records are consistent.
    pub fn check() -> bool {
        unsafe { state().check(|| memory().end()) }
    }

    /// Whether `bytes` could be allocated now (`State::can_allocate`): constant
    /// time, allocates nothing, may grow the memory.
    pub fn can_allocate(bytes: usize) -> bool {
        unsafe { state().can_allocate(memory(), bytes) }
    }
}

unsafe impl GlobalAlloc for Heap {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        state().alloc(memory(), layout.size(), layout.align())
    }

    unsafe fn dealloc(&self, pointer: *mut u8, _layout: Layout) {
        state().dealloc(pointer)
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        state().realloc(memory(), pointer, layout.size(), layout.align(), new_size)
    }
}
