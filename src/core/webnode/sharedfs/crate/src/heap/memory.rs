//! Where the heap's bytes come from. On wasm32 that is the module's linear
//! memory; natively it is an arena, so the tests run the same allocator code.

/// The unit a memory grows by: a WebAssembly page.
pub(super) const PAGE: usize = 65536;

/// The two operations the allocator needs from a memory.
pub(super) trait Memory {
    /// The first address the heap may use.
    fn base(&self) -> usize;
    /// One past the memory's last byte. A `u64`, since a 4 GiB wasm32 memory
    /// ends at 2^32, which a 32-bit `usize` cannot hold.
    fn end(&self) -> u64;
    /// Adds `pages` pages after `end()`. False when they cannot be had.
    fn grow(&mut self, pages: usize) -> bool;
}

/// The module's linear memory, from the linker's `__heap_base` upward.
#[cfg(target_arch = "wasm32")]
pub(super) struct Linear;

#[cfg(target_arch = "wasm32")]
impl Memory for Linear {
    fn base(&self) -> usize {
        extern "C" {
            static __heap_base: u8;
        }
        (&raw const __heap_base) as usize
    }

    fn end(&self) -> u64 {
        core::arch::wasm32::memory_size(0) as u64 * PAGE as u64
    }

    fn grow(&mut self, pages: usize) -> bool {
        core::arch::wasm32::memory_grow(0, pages) != usize::MAX
    }
}

/// A fixed reservation that behaves like a linear memory: it starts with
/// `initial` bytes in use and grows by pages up to `limit`. The heap starts
/// `base_offset` bytes in, as it starts at `__heap_base` on wasm32.
#[cfg(not(target_arch = "wasm32"))]
pub(super) struct Arena {
    start: usize,
    limit: usize,
    committed: usize,
    base_offset: usize,
}

#[cfg(not(target_arch = "wasm32"))]
impl Arena {
    pub(super) fn new(limit: usize, initial: usize, base_offset: usize) -> Arena {
        let limit = limit.div_ceil(PAGE).max(1) * PAGE;
        let layout = Self::layout(limit);
        // Zeroed, as a new wasm memory is; aligned to a page, so addresses have
        // the same alignment they would have in a linear memory.
        let start = unsafe { std::alloc::GlobalAlloc::alloc_zeroed(&std::alloc::System, layout) };
        if start.is_null() {
            std::alloc::handle_alloc_error(layout);
        }
        Arena {
            start: start as usize,
            limit,
            committed: initial.div_ceil(PAGE).min(limit / PAGE) * PAGE,
            base_offset,
        }
    }

    fn layout(limit: usize) -> std::alloc::Layout {
        std::alloc::Layout::from_size_align(limit, PAGE).expect("arena layout")
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for Arena {
    fn drop(&mut self) {
        unsafe {
            std::alloc::GlobalAlloc::dealloc(
                &std::alloc::System,
                self.start as *mut u8,
                Self::layout(self.limit),
            )
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Memory for Arena {
    fn base(&self) -> usize {
        self.start + self.base_offset
    }

    fn end(&self) -> u64 {
        (self.start + self.committed) as u64
    }

    fn grow(&mut self, pages: usize) -> bool {
        match pages
            .checked_mul(PAGE)
            .and_then(|bytes| bytes.checked_add(self.committed))
        {
            Some(committed) if committed <= self.limit => {
                self.committed = committed;
                true
            }
            _ => false,
        }
    }
}
