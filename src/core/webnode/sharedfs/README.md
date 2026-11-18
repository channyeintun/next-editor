# sharedfs

webnode's filesystem as a Rust module that every worker of a runtime runs on
**one shared memory**. A process reads and writes files itself, with a function
call, instead of asking the kernel worker and sleeping until it answers.

It implements the same contract as the TypeScript filesystem
(`kernel/vfs/vfs.ts`, `VfsApi` in `kernel/vfs/types.ts`), which stays as the
reference the tests compare it with and as the fallback where a shared memory
cannot be made.

## Why

A filesystem call from a process used to be a round trip to the kernel worker:
about 15 µs whatever the call (`statSync` 19 µs against 2 µs in Node). Module
resolution makes tens of thousands of them. JavaScript objects cannot be shared
between workers; a WebAssembly memory can.

## How it works

```
kernel worker                      process worker (one per process)
  SharedFs ──┐                       SharedFs ──┐
  instance   │                       instance   │      each worker has its own
             ▼                                  ▼      instance of the SAME module
        ┌────────────── one shared WebAssembly.Memory ──────────────┐
        │ stack │ statics: the shared block │ heap: inodes, names,   │
        │       │ (lock, slots, result,     │ directory tables, file │
        │       │  arguments)               │ contents, event log    │
        └────────────────────────────────────────────────────────────┘
```

- **The Rust code is single-threaded.** It has no atomics and no locks. A
  mutex in JavaScript (`lock.ts`, one word in the shared block) is taken around
  every call, so one worker's call finishes before the next begins. That is
  also why the instances can share one stack: only one of them is ever running.
- **Plain stable Rust, no dependencies.** The module is built for
  `wasm32-unknown-unknown` with an imported memory, then made shareable by the
  build script (`scripts/build-webnode-fs-wasm.mjs`, `shareMemory`): the memory
  import is marked shared; the data section is taken out and written into the
  memory once, by the kernel; the start function is taken out. Both would
  otherwise reset the statics every time another worker instantiated the
  module. A test that loses no update across four workers guards this.
- **The kernel creates it.** `boot.ts` makes the memory, compiles the module,
  writes the initial data and calls `fs_init`. It hands each process the
  compiled module, the memory and a slot (below) in its init message.
- **Paths go direct, descriptors stay in the kernel.** A process calls the
  path operations itself (`stat`, `readFile`, `writeFile`, `readdir`, `mkdir`,
  `rename` …). Open files (`open`/`read`/`write`/`close`) still go through the
  kernel, which owns every file descriptor (they are inherited, and shared with
  pipes and terminals); the kernel's open files are handles in this filesystem.
  Paths under `/dev/` are the kernel's too.
- **Watching.** A change is appended to an event log in the shared memory,
  while at least one watch exists. Only the kernel delivers events: it drains
  the log after its own calls, and when a process tells it the log went from
  empty to not empty (one `fs.changed` message for a whole burst).

## Rules

- Every call into the module is made with the lock held, and through
  `SharedFs.call`. There is no lock-free read: the instances share a stack.
- Nothing may run JavaScript while the lock is held except the binding's own
  copying of bytes in and out. The module imports only its memory and a clock.
- **A worker is never terminated inside a call.** Terminating one that holds
  the lock would leave it held for good, and the tree half changed. A process
  enters through a slot: before taking the lock it swaps its token there for
  the token negated ("inside"), and after releasing it swaps it back. To retire
  it the kernel clears the slot when it holds the token ("outside"); when it
  holds the negated token, the kernel marks it `SLOT_RETIRING` and waits for
  the call to end, at which the process clears the slot itself and parks. Only
  then does the kernel terminate it. A process that finds its slot without its
  token parks without touching the lock. (`worker.terminate()` only asks; the
  worker can run on for a moment, which is what the token is for. Terminating
  with the lock held instead, as an earlier version did, still let the worker
  take the lock in that moment and die holding it; a test retiring 200 busy
  workers caught it.)
- **A trap poisons the filesystem.** When a call fails inside the module (a
  bug), the tree may be half changed: the binding marks the block poisoned,
  releases the lock, and every later call in every worker fails with `EIO`.
  Only an error that escapes the module does this. An error in the binding's
  own JavaScript, outside the module, is rethrown as it is: the tree is whole.
- **Running out of stack is not a trap inside the module.** The instances run
  on the caller's JavaScript stack, so a program that recurses until the stack
  is full could have its next filesystem call overflow inside the module.
  `SharedFs.call` first calls a few frames deep in JavaScript (`probeStack`):
  with too little stack left the `RangeError` is thrown there, before the slot
  or the lock is touched.
- **A worker that never leaves a call is abandoned.** `retire` waits for a
  call to end for 10 seconds (a call takes microseconds). After that the worker
  is not coming back: the kernel poisons the filesystem, frees the lock and
  terminates it, rather than wait for ever with every process stopped.
- **Running out of memory is `ENOSPC`, not a trap.** An operation that adds to
  the tree first makes sure 1 MiB can still be had (`HEADROOM` in `fs.rs`,
  `Heap::can_allocate`), then takes every piece that can fail before it changes
  anything. Every growth of file data, a table or the event log leaves that
  much behind, or is undone. A call that fails with `ENOSPC` leaves everything
  that can be observed as it was: the tree, the times, the event log, the next
  inode number. (`mkdir -p` cannot know up front how many directories it will
  make, so it undoes the ones it made.) An error that needs no memory to find,
  such as `EEXIST`, comes before `ENOSPC`. Removing by a plain path, truncating
  to less, closing and reading need no memory, so a full filesystem can always
  be emptied.
- **Removing a tree needs no memory and no recursion.** `rm -r` walks down and
  back up by the parent links, and takes each directory's entries out of its
  map as it goes: sorted into the order they were made (the order the
  TypeScript filesystem removes in) when the memory for that can be had, and
  straight from the map, in the order of their names, when it cannot. Only
  then do the events of that one removal come in another order. A tree the
  permissions do not let go of entirely is removed the second way, in the
  order a listing gives the names in both filesystems, up to the first
  refusal: what was removed before it stays removed.
- Recursion is bounded: an operation whose depth depends on the data (removing
  a tree, checking that a tree may be removed, `mkdir -p`, following links) is
  written as a loop.
- The Rust mirrors `kernel/vfs/vfs.ts` function for function, including where
  it reads the clock: a test runs the same operations on both and compares the
  results, the errors, the timestamps and the events.

## The contract (`abi.ts`, `crate/src/abi.rs`)

`fs_base()` returns the address of the shared block. Its layout is in `abi.rs`.

Every call is checked against the permission bits (the owner's: a file
belongs to the one user every process runs as, or, once `fs_give_to_root` gave
it so, to root, whose files the others' bits decide, only root changes the
mode or times of (setting both times to now needs only write permission),
and whose entries only root removes or renames), as `kernel/vfs/vfs.ts`
checks them. The block's
`privileged` word says whose call it is: the binding writes it before every
call, under the lock, 1 for the kernel's privileged calls (the page's requests
and the kernel's setup, `SharedFs.privileged`) and 0 for every other. A
process's instance never writes 1.

What a call creates (`fs_open` and `fs_write_file` with `O_CREAT`, `fs_mkdir`,
`fs_mkdtemp`) gets its mode less the caller's file mode creation mask, the
block's `umask` word, as `kernel/vfs/vfs.ts` masks it. The binding writes that
word before every call too, under the lock: the mask of the caller its call is
made for (`SharedFs.withUmask`: the process's own in a process, the mask of
the process it acts for in the kernel), and `DEFAULT_UMASK` (022, `umask.ts`)
outside one and for every privileged call. A symbolic link is 0777 and a copy
(`fs_copy_file`) has its source's mode, whatever the mask.

A call passes its paths as UTF-8 in the argument area: the first at `args[0..a]`,
the second at `args[a..a+b]`; `a` and `b` are parameters. Every export returns an
`i32`: zero or more on success, `-1` on failure. A failure leaves `errno`,
`syscall` and `path_mode` in the block; the binding turns them into the
`SystemError` the TypeScript filesystem throws for the same call. Numbers that
JavaScript does not keep to 32 bits (a length, a position, a mode, a time) are
`f64`; a position of `NaN` means "at the file offset".

| Export                                                                    | Success                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs_base()`                                                               | the shared block's address                                                                                                                                                                     |
| `fs_init()`                                                               | makes the root directory the first time it is called                                                                                                                                           |
| `fs_stat(a, follow)`                                                      | `stat` holds the record                                                                                                                                                                        |
| `fs_exists(a)`                                                            | 1 there; 0 nothing; 2 a symbolic link that leads nowhere or into a loop; never fails                                                                                                           |
| `fs_readdir(a)`                                                           | `ptr`/`len`: the listing; `aux`: how many entries                                                                                                                                              |
| `fs_mkdir(a, recursive, mode: f64, floor)`                                | when recursive and a directory was made: `aux` 1 and `ptr`/`len` the first one made; else `aux` 0. A recursive one makes nothing `floor` bytes long or shorter (ENOENT instead); 0 is no floor |
| `fs_rmdir(a)` `fs_unlink(a)` `fs_rm(a, recursive, force)`                 |                                                                                                                                                                                                |
| `fs_rename(a, b)` `fs_link(a, b)` `fs_copy_file(a, b, mode)`              |                                                                                                                                                                                                |
| `fs_symlink(a, b)`                                                        | `a` is the target, `b` the path                                                                                                                                                                |
| `fs_readlink(a)` `fs_realpath(a)` `fs_watch_path(a)`                      | `ptr`/`len`: the path                                                                                                                                                                          |
| `fs_chmod(a, mode, follow)` `fs_utimes(a, atime: f64, mtime: f64, flags)` | EPERM on a node root owns, when checked; `flags`: `UTIME_FOLLOW`, and `UTIME_ATIME_NOW`/`UTIME_MTIME_NOW` to set that time to now (both: EACCES unless writable instead)                       |
| `fs_give_to_root(a)`                                                      | the node (a final link itself) is root's; EPERM when checked                                                                                                                                   |
| `fs_truncate(a, length: f64)` `fs_access(a, mode)`                        |                                                                                                                                                                                                |
| `fs_mkdtemp(a)`                                                           | `a` is one candidate path: 1 made, 0 the name is taken                                                                                                                                         |
| `fs_read_file(a)`                                                         | `ptr`/`len`: the file's bytes                                                                                                                                                                  |
| `fs_write_file(a, flags, mode: f64, length)`                              | `ptr`: where the caller copies `length` bytes                                                                                                                                                  |
| `fs_open(a, flags, mode: f64)`                                            | a handle                                                                                                                                                                                       |
| `fs_handle_read(h, length: f64, position: f64)`                           | `ptr`/`len`: the bytes read                                                                                                                                                                    |
| `fs_handle_write(h, length, position: f64)`                               | `ptr`: where the caller copies `length` bytes                                                                                                                                                  |
| `fs_handle_stat(h)`                                                       | `stat` holds the record                                                                                                                                                                        |
| `fs_handle_truncate(h, length: f64)` `fs_handle_chmod(h, mode)`           |                                                                                                                                                                                                |
| `fs_handle_utimes(h, atime: f64, mtime: f64)` `fs_handle_close(h)`        |                                                                                                                                                                                                |
| `fs_events()`                                                             | `ptr`/`len`: the event log                                                                                                                                                                     |
| `fs_events_clear()`                                                       | empties the log                                                                                                                                                                                |
| `fs_totals()`                                                             | `stat[0]`: live inodes; `stat[1]`: bytes of file data                                                                                                                                          |
| `fs_check()`                                                              | 0 when the heap and the tree are consistent; -1 when not; 1 when there was no memory to look                                                                                                   |

Bytes at `ptr` are valid until the lock is released: the caller copies them out,
or in, before it lets go.

A listing is entries of `[kind: u8][length: u32 LE][name bytes]`, in the order
of the names' bytes. That is the order of their code points, in which
`kernel/vfs/vfs.ts` lists too, so the binding passes the listing on as it
comes. (JavaScript's own order of strings is another: it puts a name with a
code point past U+FFFF before one with U+E000 to U+FFFF.) The event log
is entries of `[type: u8][length: u32 LE][path bytes]`, oldest first. An event
that does not fit (the log stops at 64 MiB, and never takes memory the tree
needs) is dropped and `events_dropped` is set; nothing more is logged until
the log is drained. The mark alone, with an empty log, is something to deliver
too: the kernel then tells every watcher that something changed. A drained log
of more than 64 KiB is freed.

`fs_write_file` and `fs_handle_write` do everything a write does (creating,
truncating, growing the file, the timestamps, the event) and leave only the
bytes to be copied, so the data crosses into the memory once.

## Layout

| File                         | What it owns                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `crate/src/abi.rs`, `abi.ts` | the contract, in both languages                                                       |
| `crate/src/heap.rs`          | the allocator over the shared memory, and whether a size can still be had             |
| `crate/src/fs.rs`            | the filesystem: inodes, path resolution, the operations, handles, the event log       |
| `crate/src/exports.rs`       | the `fs_*` functions                                                                  |
| `lock.ts`                    | the mutex                                                                             |
| `sharedFs.ts`                | `SharedFs`: `VfsApi` over the module, for the kernel and for a process                |
| `boot.ts`                    | making the memory and the first instance (kernel only; it carries the module's bytes) |
| `wasm.generated.ts`          | the built module. Generated: `bun run build:webnode-fs`                               |
| `processBackend.ts`          | a process's filesystem calls: paths direct, the rest through the kernel               |

## Building

`bun run build:webnode-fs` (`scripts/build-webnode-fs-wasm.mjs`) needs the
stable Rust toolchain with the `wasm32-unknown-unknown` target, and `wasm-opt`.
The linker flags (imported memory, 4 GiB maximum, 1 MiB stack) live in that
script, not in a cargo config, so `cargo test` builds natively with none of
them. The script refuses to write a module that is not shareable (a data or a
start section left in, a memory import that is not shared) or that names a path
of the machine that built it. `wasm.generated.ts` records a hash of the sources
it was built from; `wasm.generated.test.ts` fails when a source changed and the
module was not rebuilt. To type-check the wasm side alone:
`cargo check --target wasm32-unknown-unknown` in `crate/`.

## Tests

- `cargo test` in `crate/`: the allocator and the filesystem, natively.
  `fs/permission_tests.rs` has the permission rules (the same cases as
  `kernel/vfs/vfs.permissions.test.ts`).
  `fs/nospace_tests.rs` runs every adding operation out of memory at each
  point inside it; `fs/atomic_tests.rs` does so on random trees, under random
  modes and masks, and compares everything observable before and after;
  `fs/deep_tests.rs` covers a tree 60,000 deep on the module's 1 MiB stack,
  removal with every allocation failing, and the time large removals take.
- `kernel/vfs/vfs.test.ts` runs against both filesystems.
- `sharedFs.differential.test.ts`: random operations on both, compared, with
  random modes, so refusals (EACCES) are compared too, some calls made
  through the privileged view, and many under a random file mode creation
  mask.
- `sharedFs.workers.test.ts`: several worker threads on one memory, and busy
  workers retired inside and outside a call.
- `sharedFs.stack.test.ts`: a program that runs out of stack does not poison.
- `sharedFs.nospace.test.ts`: a small memory filled up gives `ENOSPC`, stays
  consistent and can be emptied.
- `wasm.generated.test.ts`: the built module is current, shareable, and agrees
  with `abi.ts`.
- `lock.test.ts`: the mutex under contention.
