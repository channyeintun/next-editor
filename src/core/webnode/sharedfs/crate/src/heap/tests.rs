//! The allocator, run natively over an arena: the same code that runs on wasm32.
use super::chunks::State;
use super::memory::{Arena, Memory, PAGE};

const MIB: usize = 1 << 20;

/// One heap over its own arena, so the tests can run in parallel.
struct Harness {
    state: Box<State>,
    memory: Arena,
}

impl Harness {
    fn new(limit: usize, initial: usize, base_offset: usize) -> Harness {
        Harness {
            state: Box::new(State::ZERO),
            memory: Arena::new(limit, initial, base_offset),
        }
    }

    fn alloc(&mut self, size: usize, align: usize) -> *mut u8 {
        unsafe { self.state.alloc(&mut self.memory, size, align) }
    }

    fn dealloc(&mut self, pointer: *mut u8) {
        unsafe { self.state.dealloc(pointer) }
    }

    fn realloc(
        &mut self,
        pointer: *mut u8,
        old_size: usize,
        align: usize,
        new_size: usize,
    ) -> *mut u8 {
        unsafe {
            self.state
                .realloc(&mut self.memory, pointer, old_size, align, new_size)
        }
    }

    fn check(&self) -> bool {
        unsafe { self.state.check(|| self.memory.end()) }
    }

    fn can_allocate(&mut self, size: usize) -> bool {
        unsafe { self.state.can_allocate(&mut self.memory, size) }
    }

    /// The largest request `can_allocate` says yes to (it is monotonic in the size).
    fn largest_allocatable(&mut self) -> usize {
        let (mut yes, mut no) = (0, usize::MAX / 2);
        while no - yes > 1 {
            let middle = yes + (no - yes) / 2;
            if self.can_allocate(middle) {
                yes = middle;
            } else {
                no = middle;
            }
        }
        yes
    }

    /// Nothing is allocated and no free chunk is left outside the top chunk.
    fn is_one_free_region(&self) -> bool {
        self.state.top == self.state.first && self.state.fl_map == 0
    }
}

/// xorshift64*: deterministic, and enough to shuffle sizes and orders.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }

    fn between(&mut self, low: usize, high: usize) -> usize {
        low + self.below(high - low + 1)
    }

    /// Mostly small, sometimes kilobytes, rarely megabytes.
    fn size(&mut self) -> usize {
        match self.below(1000) {
            0..=699 => self.between(1, 64),
            700..=969 => self.between(65, 4096),
            970..=997 => self.between(4097, 256 * 1024),
            _ => self.between(256 * 1024, 4 * MIB),
        }
    }

    fn align(&mut self) -> usize {
        if self.below(20) == 0 {
            1 << self.below(13)
        } else {
            1 << self.below(4)
        }
    }
}

/// The pattern a block with `id` holds: each word differs by id and by
/// position, so overlap and a copy from the wrong offset both show.
fn word(id: u64, index: usize) -> u64 {
    id.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (index as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F)
}

fn fill(pointer: *mut u8, size: usize, id: u64) {
    let words = size / 8;
    for index in 0..words {
        unsafe { (pointer.add(index * 8) as *mut u64).write_unaligned(word(id, index)) }
    }
    for at in words * 8..size {
        unsafe { pointer.add(at).write(word(id, at) as u8) }
    }
}

/// Whether the first `size` bytes at `pointer` hold the pattern of a block of
/// `full` bytes with `id`.
fn holds(pointer: *const u8, size: usize, full: usize, id: u64) -> bool {
    let words = full / 8;
    let whole = (size / 8).min(words);
    for index in 0..whole {
        if unsafe { (pointer.add(index * 8) as *const u64).read_unaligned() } != word(id, index) {
            return false;
        }
    }
    let tail_start = whole * 8;
    for at in tail_start..size {
        let expected = if at < words * 8 {
            (word(id, at / 8) >> (at % 8 * 8)) as u8
        } else {
            word(id, at) as u8
        };
        if unsafe { pointer.add(at).read() } != expected {
            return false;
        }
    }
    true
}

#[derive(Clone, Copy)]
struct Block {
    pointer: *mut u8,
    size: usize,
    align: usize,
    id: u64,
}

fn randomized(seed: u64, operations: usize) {
    let mut heap = Harness::new(1 << 30, 0, 1234);
    let mut rng = Rng(seed);
    let mut slots: Vec<Option<Block>> = vec![None; 512];
    let mut next_id = 1u64;
    for operation in 0..operations {
        let slot = rng.below(slots.len());
        match slots[slot] {
            None => {
                let (size, align) = (rng.size(), rng.align());
                let pointer = heap.alloc(size, align);
                assert!(
                    !pointer.is_null(),
                    "seed {seed} op {operation}: alloc({size}, {align}) failed"
                );
                assert_eq!(pointer as usize % align, 0);
                fill(pointer, size, next_id);
                slots[slot] = Some(Block {
                    pointer,
                    size,
                    align,
                    id: next_id,
                });
                next_id += 1;
            }
            Some(block) => {
                assert!(
                    holds(block.pointer, block.size, block.size, block.id),
                    "seed {seed} op {operation}: block overwritten"
                );
                if rng.below(2) == 0 {
                    heap.dealloc(block.pointer);
                    slots[slot] = None;
                } else {
                    let size = rng.size();
                    let pointer = heap.realloc(block.pointer, block.size, block.align, size);
                    assert!(
                        !pointer.is_null(),
                        "seed {seed} op {operation}: realloc to {size} failed"
                    );
                    assert_eq!(pointer as usize % block.align, 0);
                    assert!(
                        holds(pointer, block.size.min(size), block.size, block.id),
                        "seed {seed} op {operation}: realloc lost data"
                    );
                    fill(pointer, size, next_id);
                    slots[slot] = Some(Block {
                        pointer,
                        size,
                        align: block.align,
                        id: next_id,
                    });
                    next_id += 1;
                }
            }
        }
        if operation % 4096 == 0 {
            assert!(heap.check(), "seed {seed} op {operation}: check failed");
        }
    }
    assert!(heap.check());
    for block in slots.iter().flatten() {
        assert!(holds(block.pointer, block.size, block.size, block.id));
        heap.dealloc(block.pointer);
    }
    assert!(heap.check());
    assert!(heap.is_one_free_region());
}

#[test]
fn randomized_runs_keep_every_block_intact() {
    for seed in [0x1234_5678, 0xDEAD_BEEF, 0x0BAD_CAFE, 42] {
        randomized(seed, 200_000);
    }
}

#[test]
fn freeing_everything_leaves_one_region_that_is_reused_without_growing() {
    let mut heap = Harness::new(256 * MIB, 0, 0);
    let mut rng = Rng(7);
    let mut pointers = Vec::new();
    for _ in 0..20_000 {
        let (size, align) = (rng.size(), rng.align());
        let pointer = heap.alloc(size, align);
        assert!(!pointer.is_null());
        pointers.push(pointer);
    }
    for index in (1..pointers.len()).rev() {
        pointers.swap(index, rng.below(index + 1));
    }
    for pointer in pointers {
        heap.dealloc(pointer);
    }
    assert!(heap.check());
    assert!(heap.is_one_free_region());

    let end = heap.memory.end();
    let room = heap.state.end - heap.state.first;
    let pointer = heap.alloc(room - 64, 8);
    assert_eq!(pointer as usize, heap.state.first + size_of::<usize>());
    assert_eq!(heap.memory.end(), end, "the memory grew");
    assert!(heap.check());
}

#[test]
fn realloc_grows_in_place_when_it_can_and_moves_intact_when_it_must() {
    let mut heap = Harness::new(256 * MIB, 0, 0);

    // The last chunk before the top grows into it, the memory with it.
    let last = heap.alloc(1000, 8);
    fill(last, 1000, 1);
    let grown = heap.realloc(last, 1000, 8, 20 * MIB);
    assert_eq!(grown, last);
    assert!(holds(grown, 1000, 1000, 1));
    fill(grown, 20 * MIB, 2);

    // A chunk followed by a free one takes it over.
    let a = heap.alloc(100, 8);
    let b = heap.alloc(5000, 8);
    let guard = heap.alloc(16, 8);
    fill(a, 100, 3);
    heap.dealloc(b);
    let a_grown = heap.realloc(a, 100, 8, 4000);
    assert_eq!(a_grown, a);
    assert!(holds(a_grown, 100, 100, 3));
    assert!(heap.check());

    // Shrinking stays put, and what it gives back is used again.
    fill(a_grown, 4000, 4);
    let shrunk = heap.realloc(a_grown, 4000, 8, 200);
    assert_eq!(shrunk, a_grown);
    assert!(holds(shrunk, 200, 4000, 4));
    let reused = heap.alloc(3000, 8);
    assert!(reused as usize > shrunk as usize && (reused as usize) < guard as usize);
    assert!(heap.check());

    // Hemmed in by blocks in use, it moves, contents and alignment kept.
    let aligned = heap.alloc(300, 4096);
    // Too big for the free chunk cut off before `aligned`, so it comes after.
    let blocker = heap.alloc(64 * 1024, 8);
    fill(aligned, 300, 5);
    let moved = heap.realloc(aligned, 300, 4096, 100_000);
    assert_ne!(moved, aligned);
    assert_eq!(moved as usize % 4096, 0);
    assert!(holds(moved, 300, 300, 5));
    assert!(holds(grown, 20 * MIB, 20 * MIB, 2));
    assert!(heap.check());

    for pointer in [grown, shrunk, reused, guard, blocker, moved] {
        heap.dealloc(pointer);
    }
    assert!(heap.check());
    assert!(heap.is_one_free_region());
}

#[test]
fn exhaustion_returns_null_corrupts_nothing_and_recovers() {
    let limit = 8 * MIB;
    let mut heap = Harness::new(limit, 0, 100);
    let mut blocks = Vec::new();
    loop {
        let pointer = heap.alloc(300 * 1024, 8);
        if pointer.is_null() {
            break;
        }
        fill(pointer, 300 * 1024, blocks.len() as u64);
        blocks.push(pointer);
    }
    assert!(blocks.len() >= 20, "only {} blocks fit", blocks.len());
    assert!(heap.check());

    // Requests that cannot fit, or cannot even be sized, fail cleanly.
    for (size, align) in [
        (limit, 8),
        (usize::MAX, 8),
        (usize::MAX - 64, 8),
        (64, 1 << 40),
        (usize::MAX / 2, 4096),
    ] {
        assert!(heap.alloc(size, align).is_null());
    }
    let first = blocks[0];
    assert!(heap.realloc(first, 300 * 1024, 8, limit).is_null());
    assert!(heap.realloc(first, 300 * 1024, 8, usize::MAX - 8).is_null());
    assert!(heap.check());
    for (id, &pointer) in blocks.iter().enumerate() {
        assert!(
            holds(pointer, 300 * 1024, 300 * 1024, id as u64),
            "block {id} corrupted"
        );
    }

    // Small requests still fit in what is left over, until that runs out too.
    while !heap.alloc(64, 8).is_null() {}
    assert!(heap.check());

    for pointer in blocks.drain(..) {
        heap.dealloc(pointer);
    }
    assert!(heap.check());
    let pointer = heap.alloc(4 * MIB, 4096);
    assert!(!pointer.is_null());
    fill(pointer, 4 * MIB, 99);
    assert!(holds(pointer, 4 * MIB, 4 * MIB, 99));
    assert!(heap.check());
}

#[test]
fn a_failed_growth_step_retries_with_the_exact_need() {
    // A 1.5 MiB memory cannot grow by the 2 MiB step a 1.2 MiB request rounds
    // to, but has the pages the request needs.
    let mut heap = Harness::new(MIB + MIB / 2, 0, 0);
    let pointer = heap.alloc(MIB + MIB / 5, 8);
    assert!(!pointer.is_null());
    assert!(heap.memory.end() - (pointer as u64) < (MIB + MIB / 4) as u64 + PAGE as u64);
    assert!(heap.check());
}

#[test]
fn small_steps_do_not_each_grow_the_memory() {
    let mut heap = Harness::new(64 * MIB, 0, 0);
    let mut grows = 0;
    let mut end = heap.memory.end();
    for _ in 0..10_000 {
        assert!(!heap.alloc(100, 8).is_null());
        if heap.memory.end() != end {
            grows += 1;
            end = heap.memory.end();
        }
    }
    // 10 000 chunks of 112 bytes are about 1.1 MiB: two steps of 1 MiB.
    assert!(grows <= 2, "{grows} grows");
}

#[test]
fn the_all_zero_state_is_valid_and_ready_for_any_first_call() {
    let zero = State::ZERO;
    let bytes = unsafe {
        core::slice::from_raw_parts(&zero as *const State as *const u8, size_of::<State>())
    };
    assert!(
        bytes.iter().all(|&byte| byte == 0),
        "State::ZERO is not all zero bytes"
    );

    // check() first: valid, and it does not set the heap up.
    let heap = Harness::new(4 * MIB, 0, 77);
    assert!(heap.check());
    assert!(!heap.state.ready);

    // alloc() first, with memory already there and without.
    for initial in [0, 2 * PAGE] {
        let mut heap = Harness::new(4 * MIB, initial, 77);
        let pointer = heap.alloc(10, 1);
        assert!(!pointer.is_null());
        fill(pointer, 10, 1);
        assert!(heap.check());
        heap.dealloc(pointer);
        assert!(heap.is_one_free_region());
    }

    // An aligned alloc() first.
    let mut heap = Harness::new(4 * MIB, 0, 77);
    let pointer = heap.alloc(10, 4096);
    assert_eq!(pointer as usize % 4096, 0);
    assert!(heap.check());

    // A heap whose base lies past the memory's end grows to reach it.
    let mut heap = Harness::new(4 * MIB, PAGE, 3 * PAGE + 5);
    assert!(heap.check());
    let pointer = heap.alloc(10, 8);
    assert!(pointer as u64 > heap.memory.base() as u64);
    assert!(heap.check());
}

#[test]
fn many_small_blocks_come_and_go() {
    let mut heap = Harness::new(256 * MIB, 0, 0);
    let mut rng = Rng(99);
    let mut blocks = Vec::with_capacity(200_000);
    for id in 0..200_000u64 {
        let size = rng.between(1, 64);
        let pointer = heap.alloc(size, 1 << rng.below(4));
        assert!(!pointer.is_null());
        fill(pointer, size, id);
        blocks.push((pointer, size, id));
    }
    assert!(heap.check());

    // A block costs its size, rounded up to the alignment, plus one header
    // word; never a minimal free chunk's four words more.
    let footprint = heap.state.top - heap.state.first;
    let requested: usize = blocks.iter().map(|&(_, size, _)| size).sum();
    assert!(footprint < requested + blocks.len() * 4 * size_of::<usize>());

    // Free every other one, then the rest, so coalescing joins both sides.
    for (index, &(pointer, size, id)) in blocks.iter().enumerate() {
        if index % 2 == 0 {
            assert!(holds(pointer, size, size, id));
            heap.dealloc(pointer);
        }
    }
    assert!(heap.check());
    for (index, &(pointer, size, id)) in blocks.iter().enumerate() {
        if index % 2 == 1 {
            assert!(holds(pointer, size, size, id));
            heap.dealloc(pointer);
        }
    }
    assert!(heap.check());
    assert!(heap.is_one_free_region());
}

#[test]
fn can_allocate_answers_at_the_boundary_and_its_yes_is_kept() {
    let limit = 8 * MIB;
    let mut heap = Harness::new(limit, 0, 100);
    let largest = heap.largest_allocatable();
    // All of the arena but the heap's start and one chunk header.
    assert!(largest > limit - 200 && largest < limit, "{largest}");
    assert!(!heap.can_allocate(largest + 1));
    assert!(!heap.can_allocate(usize::MAX));
    assert!(heap.check());
    // Asking grew the memory to the limit, and the answer holds: it fits.
    assert_eq!(
        heap.memory.end() - heap.memory.base() as u64 + 100,
        limit as u64
    );
    let pointer = heap.alloc(largest, 8);
    assert!(!pointer.is_null());
    fill(pointer, largest, 7);
    assert!(!heap.can_allocate(1));
    assert!(heap.check());
    heap.dealloc(pointer);
    assert!(heap.can_allocate(largest));
    assert!(heap.is_one_free_region());
    assert!(heap.check());
}

#[test]
fn can_allocate_finds_freed_chunks_once_the_memory_is_at_its_limit() {
    let mut heap = Harness::new(4 * MIB, 0, 0);
    let mut blocks = Vec::new();
    loop {
        let pointer = heap.alloc(100 * 1024, 8);
        if pointer.is_null() {
            break;
        }
        fill(pointer, 100 * 1024, blocks.len() as u64);
        blocks.push(pointer);
    }
    while !heap.alloc(16, 8).is_null() {}
    assert!(!heap.can_allocate(16));
    let end = heap.memory.end();

    // A freed block in the middle is a bin chunk: its size is had again, a
    // bit more is not (its neighbours are in use), and the memory stays as it is.
    heap.dealloc(blocks[5]);
    assert!(heap.can_allocate(100 * 1024));
    assert!(heap.can_allocate(90 * 1024));
    assert!(!heap.can_allocate(101 * 1024));
    // Two neighbours freed coalesce into one chunk that holds both.
    heap.dealloc(blocks[6]);
    assert!(heap.can_allocate(200 * 1024));
    assert!(!heap.can_allocate(300 * 1024));
    assert_eq!(heap.memory.end(), end);
    assert!(heap.check());
    for (id, &pointer) in blocks.iter().enumerate() {
        if id != 5 && id != 6 {
            assert!(
                holds(pointer, 100 * 1024, 100 * 1024, id as u64),
                "block {id} corrupted"
            );
        }
    }
    let pointer = heap.alloc(200 * 1024, 8);
    assert!(!pointer.is_null());
    assert!(heap.check());
}

#[test]
fn can_allocate_grows_the_memory_only_by_what_is_missing() {
    let mut heap = Harness::new(64 * MIB, 0, 0);
    assert!(heap.can_allocate(10));
    assert_eq!(heap.memory.end() - heap.memory.base() as u64, MIB as u64);
    // The top has room: nothing grows.
    assert!(heap.can_allocate(MIB / 2));
    assert_eq!(heap.memory.end() - heap.memory.base() as u64, MIB as u64);
    // 3 MiB more than there is: the growth step rounds the missing amount up to 1 MiB.
    assert!(heap.can_allocate(3 * MIB + MIB / 2));
    assert_eq!(
        heap.memory.end() - heap.memory.base() as u64,
        4 * MIB as u64
    );
    let pointer = heap.alloc(3 * MIB + MIB / 2, 8);
    assert!(!pointer.is_null());
    assert_eq!(
        heap.memory.end() - heap.memory.base() as u64,
        4 * MIB as u64
    );
    assert!(heap.check());
    // Past the limit: false, and the memory is not grown for nothing.
    assert!(!heap.can_allocate(64 * MIB));
    assert_eq!(
        heap.memory.end() - heap.memory.base() as u64,
        4 * MIB as u64
    );
    assert!(heap.check());
}

#[test]
fn can_allocate_sets_up_an_untouched_heap() {
    let mut heap = Harness::new(4 * MIB, 0, 77);
    assert!(!heap.state.ready);
    assert!(heap.can_allocate(MIB));
    assert!(heap.state.ready);
    assert!(heap.check());
    assert!(!heap.alloc(MIB, 8).is_null());
    assert!(heap.check());
}
