//! The allocator proper: boundary-tagged chunks, segregated free lists with a
//! two-level bitmap (TLSF) and a top chunk that the memory grows into.
//!
//! A chunk is a header word followed by the caller's bytes:
//!
//! ```text
//! in use:  [size | flags][payload .......................]
//! free:    [size | flags][next][prev] ........... [size]
//! ```
//!
//! The header holds the chunk's size (a multiple of `ALIGN`) and two flags: the
//! chunk is in use, and the chunk before it is in use. A free chunk repeats its
//! size in its last word, so the chunk after it can find where it starts; an in
//! use chunk does not need to, which keeps a small chunk's overhead at one
//! word. Payloads are `ALIGN`-aligned, so chunks start one word before an
//! `ALIGN` boundary.
//!
//! Invariants, all verified by `check`:
//! - chunks tile `[first, top)` exactly, and each one's "previous in use" flag
//!   tells the truth (the first chunk's is set);
//! - no two free chunks are adjacent, and the chunk just before `top` is in use:
//!   freeing coalesces with both neighbours and merges into the top chunk;
//! - every free chunk is in exactly the bin its size maps to, and the bitmaps
//!   mark exactly the bins that are not empty;
//! - `[top, end)` is the top chunk: memory that is ours and holds no chunk.
use super::memory::{Memory, PAGE};

const WORD: usize = size_of::<usize>();
const ALIGN: usize = 2 * WORD;
const ALIGN_LOG: usize = ALIGN.trailing_zeros() as usize;
/// A free chunk's header, two links and footer.
const MIN_CHUNK: usize = 4 * WORD;

const IN_USE: usize = 1;
const PREV_IN_USE: usize = 2;
const FLAGS: usize = IN_USE | PREV_IN_USE;

/// Each power of two of sizes is split into `2^SL_LOG` bins.
const SL_LOG: usize = 4;
const SL_COUNT: usize = 1 << SL_LOG;
const FL_SHIFT: usize = SL_LOG + ALIGN_LOG;
/// Below this, each multiple of `ALIGN` has its own bin (first level 0).
const SMALL_LIMIT: usize = 1 << FL_SHIFT;
const FL_COUNT: usize = usize::BITS as usize - FL_SHIFT + 1;

/// The least the memory grows by, so that small allocations do not each cost a
/// `memory.grow`.
const GROW_STEP: usize = 1 << 20;
/// The highest address a chunk may end at. A 4 GiB wasm32 memory ends at 2^32,
/// one past what a `usize` holds: its last byte is given up.
const LIMIT: usize = usize::MAX;

/// Everything the allocator knows. All zero is a valid state, the one a new
/// memory starts in: `ready` is false and the heap sets itself up on first use.
pub(super) struct State {
    pub(super) ready: bool,
    /// Where the first chunk starts.
    pub(super) first: usize,
    /// Where the top chunk starts: the end of the last chunk.
    pub(super) top: usize,
    /// Where the top chunk, and the memory the heap may use, ends.
    pub(super) end: usize,
    /// Bit `fl` is set when some bin of first level `fl` is not empty.
    pub(super) fl_map: usize,
    /// Bit `sl` of `sl_map[fl]` is set when `bins[fl][sl]` is not empty.
    sl_map: [u32; FL_COUNT],
    /// The first free chunk of each bin, or 0.
    bins: [[usize; SL_COUNT]; FL_COUNT],
}

unsafe fn get(address: usize) -> usize {
    (address as *const usize).read()
}

unsafe fn set(address: usize, value: usize) {
    (address as *mut usize).write(value)
}

unsafe fn size_of_chunk(chunk: usize) -> usize {
    get(chunk) & !FLAGS
}

unsafe fn next_link(chunk: usize) -> usize {
    get(chunk + WORD)
}

unsafe fn prev_link(chunk: usize) -> usize {
    get(chunk + 2 * WORD)
}

/// The chunk that holds `request` bytes, or `None` when no chunk could.
fn chunk_size(request: usize) -> Option<usize> {
    let size = request.checked_add(WORD + ALIGN - 1)? & !(ALIGN - 1);
    Some(size.max(MIN_CHUNK))
}

fn top_bit(size: usize) -> usize {
    (usize::BITS - 1 - size.leading_zeros()) as usize
}

/// The bin a free chunk of `size` bytes belongs in.
fn bin_of(size: usize) -> (usize, usize) {
    if size < SMALL_LIMIT {
        return (0, size >> ALIGN_LOG);
    }
    let log = top_bit(size);
    (log - FL_SHIFT + 1, (size >> (log - SL_LOG)) - SL_COUNT)
}

/// The first bin whose every chunk holds at least `size` bytes, or `None` when
/// no bin can. Taking from it needs no search within the list.
fn bin_at_least(size: usize) -> Option<(usize, usize)> {
    if size < SMALL_LIMIT {
        return Some(bin_of(size));
    }
    let rounded = size.checked_add((1 << (top_bit(size) - SL_LOG)) - 1)?;
    Some(bin_of(rounded))
}

/// Where a chunk's payload ends up when it is cut out of `chunk` so that the
/// payload is aligned to `align`: in place when it already is, else far enough
/// in that the part cut off before it can be a free chunk of its own.
fn aligned_chunk(chunk: usize, align: usize) -> usize {
    let payload = chunk + WORD;
    if payload & (align - 1) == 0 {
        return chunk;
    }
    ((payload + MIN_CHUNK + align - 1) & !(align - 1)) - WORD
}

fn grow_pages(memory: &mut impl Memory, pages: u64) -> bool {
    usize::try_from(pages).is_ok_and(|pages| memory.grow(pages))
}

impl State {
    pub(super) const ZERO: State = State {
        ready: false,
        first: 0,
        top: 0,
        end: 0,
        fl_map: 0,
        sl_map: [0; FL_COUNT],
        bins: [[0; SL_COUNT]; FL_COUNT],
    };

    fn init(&mut self, memory: &impl Memory) -> bool {
        let Some(aligned) = memory.base().checked_add(WORD + ALIGN - 1) else {
            return false;
        };
        self.first = (aligned & !(ALIGN - 1)) - WORD;
        self.top = self.first;
        // The memory may end before the heap's first chunk; the top chunk is
        // then empty and the first allocation grows the memory.
        self.end = (memory.end().min(LIMIT as u64) as usize).max(self.top);
        self.ready = true;
        true
    }

    /// Makes the top chunk at least `needed` bytes long, growing the memory.
    fn grow(&mut self, memory: &mut impl Memory, needed: usize) -> bool {
        let want = match (self.top as u64).checked_add(needed as u64) {
            Some(want) if want <= LIMIT as u64 => want,
            _ => return false,
        };
        let have = memory.end();
        if want > have {
            let deficit = want - have;
            let exact = deficit.div_ceil(PAGE as u64);
            let stepped = deficit.div_ceil(GROW_STEP as u64) * (GROW_STEP / PAGE) as u64;
            // The step can fail where the exact need would not, near the
            // memory's maximum or the host's.
            let grown =
                (stepped > exact && grow_pages(memory, stepped)) || grow_pages(memory, exact);
            if !grown {
                return false;
            }
        }
        self.end = memory.end().min(LIMIT as u64) as usize;
        true
    }

    unsafe fn bin(&mut self, chunk: usize, size: usize) {
        let (fl, sl) = bin_of(size);
        let head = self.bins[fl][sl];
        set(chunk + WORD, head);
        set(chunk + 2 * WORD, 0);
        if head != 0 {
            set(head + 2 * WORD, chunk);
        }
        self.bins[fl][sl] = chunk;
        self.sl_map[fl] |= 1 << sl;
        self.fl_map |= 1 << fl;
    }

    unsafe fn unbin(&mut self, chunk: usize, size: usize) {
        let (fl, sl) = bin_of(size);
        let next = next_link(chunk);
        let prev = prev_link(chunk);
        if prev == 0 {
            self.bins[fl][sl] = next;
        } else {
            set(prev + WORD, next);
        }
        if next != 0 {
            set(next + 2 * WORD, prev);
        }
        if self.bins[fl][sl] == 0 {
            self.sl_map[fl] &= !(1 << sl);
            if self.sl_map[fl] == 0 {
                self.fl_map &= !(1 << fl);
            }
        }
    }

    /// The first non-empty bin whose every chunk holds at least `size` bytes,
    /// found in constant time from the bitmaps.
    fn good_fit(&self, size: usize) -> Option<(usize, usize)> {
        let (fl, sl) = bin_at_least(size)?;
        let here = self.sl_map[fl] & (u32::MAX << sl);
        if here != 0 {
            return Some((fl, here.trailing_zeros() as usize));
        }
        let above = self.fl_map & usize::MAX.checked_shl(fl as u32 + 1).unwrap_or(0);
        if above == 0 {
            return None;
        }
        let fl = above.trailing_zeros() as usize;
        Some((fl, self.sl_map[fl].trailing_zeros() as usize))
    }

    /// Takes a free chunk of at least `size` bytes from the bins, in constant
    /// time, or returns 0.
    unsafe fn take_good_fit(&mut self, size: usize) -> usize {
        let Some((fl, sl)) = self.good_fit(size) else {
            return 0;
        };
        let chunk = self.bins[fl][sl];
        self.unbin(chunk, size_of_chunk(chunk));
        chunk
    }

    /// The last resort before failing: the bin `size` maps to may hold a
    /// chunk big enough that the good fit skipped, since it only takes from
    /// bins whose every chunk is big enough. Searches that one bin.
    unsafe fn take_from_own_bin(&mut self, size: usize) -> usize {
        let (fl, sl) = bin_of(size);
        let mut chunk = self.bins[fl][sl];
        while chunk != 0 {
            let found = size_of_chunk(chunk);
            if found >= size {
                self.unbin(chunk, found);
                return chunk;
            }
            chunk = next_link(chunk);
        }
        0
    }

    /// Marks a chunk just taken from a bin in use, and gives back what it has
    /// beyond `size`.
    unsafe fn claim(&mut self, chunk: usize, size: usize) {
        let found = size_of_chunk(chunk);
        // A free chunk's neighbours are both in use: it is never next to
        // another free chunk nor to the top.
        set(chunk, found | IN_USE | PREV_IN_USE);
        let next = chunk + found;
        set(next, get(next) | PREV_IN_USE);
        self.split_tail(chunk, size);
    }

    /// Shrinks an in-use chunk to `size` bytes when what is cut off can be a
    /// chunk of its own, and frees that.
    unsafe fn split_tail(&mut self, chunk: usize, size: usize) {
        let header = get(chunk);
        let have = header & !FLAGS;
        if have - size < MIN_CHUNK {
            return;
        }
        set(chunk, size | (header & FLAGS));
        let rest = chunk + size;
        set(rest, (have - size) | IN_USE | PREV_IN_USE);
        self.release(rest);
    }

    /// Frees an in-use chunk: coalesces it with free neighbours, then bins it
    /// or merges it into the top chunk.
    unsafe fn release(&mut self, chunk: usize) {
        let mut chunk = chunk;
        let mut size = size_of_chunk(chunk);
        if get(chunk) & PREV_IN_USE == 0 {
            let prev_size = get(chunk - WORD);
            chunk -= prev_size;
            self.unbin(chunk, prev_size);
            size += prev_size;
        }
        let next = chunk + size;
        if next == self.top {
            self.top = chunk;
            return;
        }
        let next_header = get(next);
        if next_header & IN_USE == 0 {
            let next_size = next_header & !FLAGS;
            self.unbin(next, next_size);
            size += next_size;
        } else {
            set(next, next_header & !PREV_IN_USE);
        }
        // Whatever came before is in use now: a free one was merged.
        set(chunk, size | PREV_IN_USE);
        set(chunk + size - WORD, size);
        self.bin(chunk, size);
    }

    /// An in-use chunk of at least `size` bytes, or 0.
    unsafe fn take(&mut self, memory: &mut impl Memory, size: usize) -> usize {
        let chunk = self.take_good_fit(size);
        if chunk != 0 {
            self.claim(chunk, size);
            return chunk;
        }
        if self.end - self.top < size && !self.grow(memory, size) {
            let chunk = self.take_from_own_bin(size);
            if chunk != 0 {
                self.claim(chunk, size);
            }
            return chunk;
        }
        let chunk = self.top;
        // The chunk before the top is always in use, or there is none.
        set(chunk, size | IN_USE | PREV_IN_USE);
        self.top = chunk + size;
        chunk
    }

    /// `size` bytes aligned to `align` (a power of two), or null.
    pub(super) unsafe fn alloc(
        &mut self,
        memory: &mut impl Memory,
        size: usize,
        align: usize,
    ) -> *mut u8 {
        if !self.ready && !self.init(memory) {
            return core::ptr::null_mut();
        }
        let Some(need) = chunk_size(size) else {
            return core::ptr::null_mut();
        };
        if align <= ALIGN {
            let chunk = self.take(memory, need);
            return if chunk == 0 {
                core::ptr::null_mut()
            } else {
                (chunk + WORD) as *mut u8
            };
        }
        // Take enough that an aligned chunk fits inside after a free chunk's
        // worth of lead, then give back the lead and the tail.
        let Some(padded) = need
            .checked_add(align)
            .and_then(|padded| padded.checked_add(MIN_CHUNK))
        else {
            return core::ptr::null_mut();
        };
        let chunk = self.take(memory, padded);
        if chunk == 0 {
            return core::ptr::null_mut();
        }
        let aligned = aligned_chunk(chunk, align);
        if aligned != chunk {
            let lead = aligned - chunk;
            set(
                aligned,
                (size_of_chunk(chunk) - lead) | IN_USE | PREV_IN_USE,
            );
            set(chunk, lead | IN_USE | PREV_IN_USE);
            self.release(chunk);
        }
        self.split_tail(aligned, need);
        (aligned + WORD) as *mut u8
    }

    /// Whether `size` bytes (aligned to `ALIGN`) could be allocated now, in
    /// constant time and without allocating: from the top chunk, from a bin
    /// the good fit takes from, from the first chunk of the bin `size` maps
    /// to (which `take_from_own_bin` finds), or by growing the memory by what
    /// is missing (what is grown becomes part of the free top chunk, so
    /// nothing is lost when it is not used). When it answers true, an `alloc`
    /// of `size` made right after it succeeds. It can answer false where a
    /// search of that whole bin would have found room: it errs on the safe side.
    pub(super) unsafe fn can_allocate(&mut self, memory: &mut impl Memory, size: usize) -> bool {
        if !self.ready && !self.init(memory) {
            return false;
        }
        let Some(need) = chunk_size(size) else {
            return false;
        };
        if self.end - self.top >= need || self.good_fit(need).is_some() {
            return true;
        }
        let (fl, sl) = bin_of(need);
        let head = self.bins[fl][sl];
        (head != 0 && size_of_chunk(head) >= need) || self.grow(memory, need)
    }

    pub(super) unsafe fn dealloc(&mut self, pointer: *mut u8) {
        self.release(pointer as usize - WORD);
    }

    /// Resizes the block at `pointer` (of `old_size` bytes, aligned to `align`)
    /// to `new_size` bytes: in place when it shrinks, when the chunk after it is
    /// free and big enough, or when it is the last chunk and the top can grow;
    /// else by moving it. Null, with the block untouched, when it cannot.
    pub(super) unsafe fn realloc(
        &mut self,
        memory: &mut impl Memory,
        pointer: *mut u8,
        old_size: usize,
        align: usize,
        new_size: usize,
    ) -> *mut u8 {
        let Some(need) = chunk_size(new_size) else {
            return core::ptr::null_mut();
        };
        let chunk = pointer as usize - WORD;
        let header = get(chunk);
        let have = header & !FLAGS;
        if need <= have {
            self.split_tail(chunk, need);
            return pointer;
        }
        let next = chunk + have;
        if next == self.top {
            let extra = need - have;
            if self.end - self.top >= extra || self.grow(memory, extra) {
                set(chunk, need | (header & FLAGS));
                self.top = chunk + need;
                return pointer;
            }
        } else {
            let next_header = get(next);
            let merged = have + (next_header & !FLAGS);
            if next_header & IN_USE == 0 && merged >= need {
                self.unbin(next, next_header & !FLAGS);
                set(chunk, merged | (header & FLAGS));
                // The chunk after a free one is in use, never the top.
                let after = chunk + merged;
                set(after, get(after) | PREV_IN_USE);
                self.split_tail(chunk, need);
                return pointer;
            }
        }
        let moved = self.alloc(memory, new_size, align);
        if !moved.is_null() {
            core::ptr::copy_nonoverlapping(pointer, moved, old_size.min(new_size));
            self.release(chunk);
        }
        moved
    }

    /// Whether every invariant holds. `memory_end` is asked only once the heap
    /// is set up: an untouched heap has no memory to look at.
    pub(super) unsafe fn check(&self, memory_end: impl FnOnce() -> u64) -> bool {
        if !self.ready {
            return self.first == 0
                && self.top == 0
                && self.end == 0
                && self.fl_map == 0
                && self.sl_map.iter().all(|&bits| bits == 0)
                && self.bins.iter().flatten().all(|&head| head == 0);
        }
        if !self.first.wrapping_add(WORD).is_multiple_of(ALIGN)
            || self.first > self.top
            || self.top > self.end
            // `init` lets `end` sit at `top` when the memory ends before the heap.
            || (self.end as u64 > memory_end() && self.end != self.top)
            || self.fl_map >> FL_COUNT != 0
        {
            return false;
        }

        let mut chunk = self.first;
        let mut prev_in_use = true;
        let mut free = 0usize;
        while chunk < self.top {
            let header = get(chunk);
            let size = header & !FLAGS;
            if size < MIN_CHUNK || !size.is_multiple_of(ALIGN) || size > self.top - chunk {
                return false;
            }
            if (header & PREV_IN_USE != 0) != prev_in_use {
                return false;
            }
            let in_use = header & IN_USE != 0;
            if !in_use {
                if !prev_in_use || get(chunk + size - WORD) != size {
                    return false;
                }
                free += 1;
            }
            prev_in_use = in_use;
            chunk += size;
        }
        if chunk != self.top || !prev_in_use {
            return false;
        }

        // Every binned node must be one of the `free` chunks the walk found;
        // counting them also stops a corrupted list from looping forever.
        let mut binned = 0usize;
        for fl in 0..FL_COUNT {
            let mut sl_bits = 0u32;
            for sl in 0..SL_COUNT {
                let mut node = self.bins[fl][sl];
                let mut back = 0;
                if node != 0 {
                    sl_bits |= 1 << sl;
                }
                while node != 0 {
                    if binned == free
                        || node < self.first
                        || node >= self.top
                        || self.top - node < MIN_CHUNK
                        || !node.wrapping_add(WORD).is_multiple_of(ALIGN)
                    {
                        return false;
                    }
                    let header = get(node);
                    if header & IN_USE != 0
                        || bin_of(header & !FLAGS) != (fl, sl)
                        || prev_link(node) != back
                    {
                        return false;
                    }
                    binned += 1;
                    back = node;
                    node = next_link(node);
                }
            }
            if self.sl_map[fl] != sl_bits || (self.fl_map >> fl & 1 != 0) != (sl_bits != 0) {
                return false;
            }
        }
        binned == free
    }
}
