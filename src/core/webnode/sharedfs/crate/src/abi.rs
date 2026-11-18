//! The contract with the TypeScript binding (`../abi.ts` states the same
//! numbers): where the shared block lives, what a call leaves in it, and the
//! codes for errors and system calls. Change both files together.

/// Bytes of the argument area: both paths of a call, one after the other.
pub const ARGS_CAPACITY: usize = 65536;
/// Workers that can call into the filesystem directly at one time.
pub const PROCESS_SLOTS: usize = 1024;

/// What every instance shares besides the heap. `fs_base()` is its address.
///
/// Offsets (bytes): lock 0, poisoned 4, watching 8, events_len 12, slots 16,
/// errno 4112, syscall 4116, path_mode 4120, ptr 4124, len 4128, aux 4132,
/// events_dropped 4136, privileged 4140, umask 4144, stat 4152, args 4264.
#[repr(C)]
pub struct Shared {
    /// The mutex word. Only JavaScript reads or writes it (Atomics).
    pub lock: u32,
    /// Non-zero once a call trapped inside the filesystem: its state may be torn.
    pub poisoned: u32,
    /// How many watches are registered. Events are logged only while non-zero.
    pub watching: u32,
    /// Bytes in the pending event log.
    pub events_len: u32,
    /// One word for each process slot: 0 when free; the token of the worker
    /// that may enter through it while it is outside a call; the token negated
    /// while it is inside one; `SLOT_RETIRING` once the kernel asked it to
    /// stop. Only JavaScript reads or writes them.
    pub slots: [u32; PROCESS_SLOTS],
    /// The failed call's error (`Errno`), or 0.
    pub errno: u32,
    /// The system call the error names (`Syscall`).
    pub syscall: u32,
    /// Which arguments the error names: 0 none, 1 the first path, 2 both paths.
    pub path_mode: u32,
    /// Where the call's bytes are (file data, a listing, a path, the event log).
    pub ptr: u32,
    /// How many bytes are at `ptr`.
    pub len: u32,
    /// A second number, when a call has one.
    pub aux: u32,
    /// Non-zero once the event log was full and events were dropped.
    pub events_dropped: u32,
    /// Non-zero when the call is the kernel's privileged one, which the
    /// permission bits do not apply to (the page's requests, the kernel's
    /// setup). The caller sets it before every call, under the lock.
    pub privileged: u32,
    /// The file mode creation mask of the caller: the permission bits taken
    /// off the mode of what the call creates. The caller sets it before
    /// every call, under the lock.
    pub umask: u32,
    /// A `stat` record: dev, ino, mode, nlink, uid, gid, rdev, size, blksize,
    /// blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs.
    pub stat: [f64; 14],
    /// The call's path arguments: the first at 0, the second right after it.
    pub args: [u8; ARGS_CAPACITY],
}

// The layout `abi.ts` relies on, checked where it is defined: a field added or
// moved here without the same change there does not compile.
const _: () = {
    use core::mem::offset_of;
    assert!(offset_of!(Shared, lock) == 0);
    assert!(offset_of!(Shared, poisoned) == 4);
    assert!(offset_of!(Shared, watching) == 8);
    assert!(offset_of!(Shared, events_len) == 12);
    assert!(offset_of!(Shared, slots) == 16);
    assert!(offset_of!(Shared, errno) == 4112);
    assert!(offset_of!(Shared, syscall) == 4116);
    assert!(offset_of!(Shared, path_mode) == 4120);
    assert!(offset_of!(Shared, ptr) == 4124);
    assert!(offset_of!(Shared, len) == 4128);
    assert!(offset_of!(Shared, aux) == 4132);
    assert!(offset_of!(Shared, events_dropped) == 4136);
    assert!(offset_of!(Shared, privileged) == 4140);
    assert!(offset_of!(Shared, umask) == 4144);
    assert!(offset_of!(Shared, stat) == 4152);
    assert!(offset_of!(Shared, args) == 4264);
    assert!(core::mem::align_of::<Shared>() == 8);
};

/// Error codes, by their index in `ERRNO_CODES` of `abi.ts`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Errno {
    Enoent = 1,
    Einval = 2,
    Enotdir = 3,
    Eloop = 4,
    Eexist = 5,
    Eisdir = 6,
    Ebusy = 7,
    Enotempty = 8,
    Eperm = 9,
    Enotsup = 10,
    Eacces = 11,
    Efbig = 12,
    Ebadf = 13,
    Enospc = 14,
    Enametoolong = 15,
    Eio = 16,
}

/// System call names, by their index in `SYSCALL_NAMES` of `abi.ts`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Syscall {
    Open = 1,
    Stat = 2,
    Lstat = 3,
    Scandir = 4,
    Mkdir = 5,
    Rmdir = 6,
    Unlink = 7,
    Rm = 8,
    Rename = 9,
    Link = 10,
    Symlink = 11,
    Readlink = 12,
    Realpath = 13,
    Chmod = 14,
    Utime = 15,
    Ftruncate = 16,
    Copyfile = 17,
    Access = 18,
    Mkdtemp = 19,
    Read = 20,
    Write = 21,
    Fstat = 22,
    Fchmod = 23,
    Futime = 24,
    Close = 25,
    Watch = 26,
    Chown = 27,
}

/// A slot whose worker is inside a call that the kernel retires when the call
/// ends (`i32::MIN`, as the slot words are read signed).
pub const SLOT_RETIRING: i32 = i32::MIN;

/// `fs_utimes`'s flags: follow a final link.
pub const UTIME_FOLLOW: u32 = 1;
/// `fs_utimes`'s flags: set the access time to now, not to the number given.
pub const UTIME_ATIME_NOW: u32 = 2;
/// `fs_utimes`'s flags: set the modification time to now, not to the number given.
pub const UTIME_MTIME_NOW: u32 = 4;

/// `path_mode`: the error names no path.
pub const PATH_NONE: u32 = 0;
/// `path_mode`: the error names the call's first path.
pub const PATH_FIRST: u32 = 1;
/// `path_mode`: the error names both paths, as `path` and `dest`.
pub const PATH_BOTH: u32 = 2;

/// What `fs_exists` answers: nothing at the path, something, or a symbolic
/// link that leads nowhere or into a loop.
pub const ABSENT: u32 = 0;
pub const PRESENT: u32 = 1;
pub const BROKEN_LINK: u32 = 2;

/// Entry kinds in a listing.
pub const KIND_FILE: u8 = 0;
pub const KIND_DIR: u8 = 1;
pub const KIND_SYMLINK: u8 = 2;

/// Event types in the event log.
pub const EVENT_RENAME: u8 = 0;
pub const EVENT_CHANGE: u8 = 1;
