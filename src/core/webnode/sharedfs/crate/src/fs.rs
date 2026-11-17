//! The filesystem: inodes, path resolution, the operations, open files and the
//! event log. A port of `kernel/vfs/vfs.ts`, function for function: the same
//! checks in the same order, the clock read at the same points and as often,
//! the same events. A test runs both and compares them, so a change here is a
//! change there too.
//!
//! Names and paths are bytes (UTF-8 from JavaScript, never assumed valid).
//! Nothing here recurses to a depth the data decides: walking a tree is a loop.

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use crate::abi::{
    Errno, Syscall, EVENT_CHANGE, EVENT_RENAME, KIND_DIR, KIND_FILE, KIND_SYMLINK, PATH_BOTH,
    PATH_FIRST, PATH_NONE,
};

#[cfg(test)]
mod atomic_tests;
#[cfg(test)]
mod deep_tests;
mod js;
#[cfg(test)]
mod nospace_tests;
mod path;
#[cfg(test)]
mod tests;

use path::SLASH;

pub const O_ACCMODE: u32 = 3;
pub const O_RDONLY: u32 = 0;
pub const O_WRONLY: u32 = 1;
pub const O_RDWR: u32 = 2;
pub const O_CREAT: u32 = 0o100;
pub const O_EXCL: u32 = 0o200;
pub const O_TRUNC: u32 = 0o1000;
pub const O_APPEND: u32 = 0o2000;
pub const O_DIRECTORY: u32 = 0o200000;
pub const O_NOFOLLOW: u32 = 0o400000;
pub const X_OK: u32 = 1;
pub const COPYFILE_EXCL: u32 = 1;

pub const S_IFREG: u32 = 0o100000;
pub const S_IFDIR: u32 = 0o040000;
pub const S_IFLNK: u32 = 0o120000;

/// The largest file the filesystem holds (4 GiB), as `inode.ts` states it.
pub const MAX_FILE_SIZE: f64 = 4294967296.0;
/// Linux's limit on symbolic links followed while resolving one path.
const MAX_LINKS: u32 = 40;
const UMASK: u32 = 0o022;
const DEFAULT_FILE_MODE: u32 = 0o644;
const DEFAULT_DIR_MODE: u32 = 0o755;
/// Past this the event log drops events and says so (`events_dropped`).
pub const EVENT_LOG_LIMIT: usize = 64 << 20;
/// The most of the log's buffer kept once it is emptied.
const EVENTS_KEPT: usize = 64 << 10;
/// The most of the scratch buffer kept between calls (`trim_scratch`).
const SCRATCH_KEPT: usize = 64 << 10;

const DEV: f64 = 1.0;
const UID: f64 = 1.0;
const GID: f64 = 1.0;
const BLKSIZE: f64 = 4096.0;
const DIR_SIZE: usize = 4096;

/// Where timestamps come from, in epoch milliseconds: the host's clock in the
/// module, a counter in tests.
pub trait Clock {
    fn now(&mut self) -> f64;
}

/// Whether memory is left: the allocator in the module (`Heap::can_allocate`),
/// a budget in tests. Natively the filesystem allocates from the system, which
/// never runs short, so the default says yes.
pub trait Space {
    /// Whether `bytes` could be allocated now. Constant time; allocates nothing.
    fn can_allocate(&mut self, bytes: usize) -> bool;
}

/// Memory without end.
pub struct Unlimited;

impl Space for Unlimited {
    fn can_allocate(&mut self, _bytes: usize) -> bool {
        true
    }
}

/// The memory an operation that adds to the tree makes sure is still there
/// before it changes anything, and that every growth of a buffer or a table
/// leaves behind (README.md, Rules: an allocation that cannot be had aborts,
/// and an abort poisons the filesystem for every process).
///
/// It is what the allocations that cannot fail may take, once an operation
/// has checked. Their worst case, for one operation: inserting an entry into a
/// directory's B-tree splits at most one node a level, and no directory that
/// fits in 4 GiB is more than 12 levels deep, at under 400 bytes a node on
/// wasm32: under 8 KiB. The names an operation makes are fallible, but they
/// come out of this too: an entry's key and an inode's name, each at most the
/// 64 KiB of the argument area, and a symbolic link's target, which shares
/// those 64 KiB with its name: at most 128 KiB. With the allocator's header
/// word and bin rounding (at most 1/16) that stays under 150 KiB. 1 MiB is
/// six times that, the allocator's growth step, and a fifth of a percent of
/// the smallest memory a host grants (512 MiB). Asking for it is constant
/// time (`Heap::can_allocate`), so a small write pays almost nothing.
pub const HEADROOM: usize = 1 << 20;

/// An allocation that could not be had.
#[derive(Debug)]
struct NoMemory;

/// `bytes` as a vector, or `NoMemory`.
fn copied(bytes: &[u8]) -> core::result::Result<Vec<u8>, NoMemory> {
    let mut copy = Vec::new();
    copy.try_reserve_exact(bytes.len()).map_err(|_| NoMemory)?;
    copy.extend_from_slice(bytes);
    Ok(copy)
}

/// `bytes` boxed, or `NoMemory`.
fn boxed(bytes: &[u8]) -> core::result::Result<Box<[u8]>, NoMemory> {
    copied(bytes).map(Vec::into_boxed_slice)
}

/// Makes room in `vec` for `additional` more elements, doubling when it can,
/// and only if `HEADROOM` is still there afterwards: false, with `vec` as it
/// was, when not. For the tables and logs whose one reallocation can be
/// larger than any fixed reserve.
fn grow<T>(space: &mut impl Space, vec: &mut Vec<T>, additional: usize) -> bool {
    grow_keeping(space, vec, additional, true)
}

/// `grow`, keeping `HEADROOM` only when `keep`: for a growth after which
/// nothing that cannot fail is allocated.
///
/// As `reserve` does for file data: the doubled growth is only an
/// optimisation, so when it cannot be had, or leaves less than `HEADROOM`,
/// the least growth is tried before giving up.
fn grow_keeping<T>(
    space: &mut impl Space,
    vec: &mut Vec<T>,
    additional: usize,
    keep: bool,
) -> bool {
    if vec.capacity() - vec.len() >= additional {
        return true;
    }
    let before = vec.capacity();
    for exact in [false, true] {
        let grown = if exact {
            vec.try_reserve_exact(additional)
        } else {
            vec.try_reserve(additional)
        };
        if grown.is_ok() {
            if !keep || space.can_allocate(HEADROOM) {
                return true;
            }
            // Back to what it was; shrinking happens in place and never allocates.
            vec.shrink_to(before);
        }
    }
    false
}

/// A `stat` record in `abi.rs` order: dev, ino, mode, nlink, uid, gid, rdev,
/// size, blksize, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs.
pub type Stat = [f64; 14];

/// A failed call: the error, the system call it names, and which of the call's
/// paths it names (`PATH_NONE`, `PATH_FIRST`, `PATH_BOTH`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Failure {
    pub errno: Errno,
    pub syscall: Syscall,
    pub path_mode: u32,
}

pub type Result<T> = core::result::Result<T, Failure>;

fn fail<T>(errno: Errno, syscall: Syscall, path_mode: u32) -> Result<T> {
    Err(Failure {
        errno,
        syscall,
        path_mode,
    })
}

/// A slot in the inode table.
type Idx = u32;

#[derive(Clone, Copy)]
struct Entry {
    node: Idx,
    /// When the entry was made: a JavaScript Map iterates in this order, and
    /// `remove_tree` must remove (and report) entries in it.
    seq: u64,
}

struct FileData {
    /// The buffer; its length is the capacity and bytes past `size` are zero.
    data: Vec<u8>,
    size: usize,
}

enum Kind {
    File(FileData),
    Dir(BTreeMap<Box<[u8]>, Entry>),
    Symlink(Box<[u8]>),
}

struct Inode {
    ino: u64,
    /// Permission bits only (`0o7777`); the type bits come from `kind`.
    perm: u32,
    nlink: u32,
    atime: f64,
    mtime: f64,
    ctime: f64,
    birthtime: f64,
    /// The directory holding the primary link, and its name there; None once detached.
    parent: Option<Idx>,
    name: Box<[u8]>,
    /// Open handles on this node. A file keeps its data while this is above
    /// zero; any node keeps its slot.
    handles: u32,
    /// No longer counted in the totals (`release` in vfs.ts). The slot stays
    /// only while a handle still refers to it: a removed directory held open.
    released: bool,
    kind: Kind,
}

impl Inode {
    fn is_dir(&self) -> bool {
        matches!(self.kind, Kind::Dir(_))
    }

    fn is_file(&self) -> bool {
        matches!(self.kind, Kind::File(_))
    }

    fn is_symlink(&self) -> bool {
        matches!(self.kind, Kind::Symlink(_))
    }
}

/// Where a path led. `parent`/`name` are the entry that names `node` (absent
/// when it does not exist yet); `parent` is None when the path ends at a
/// directory without naming an entry (`/`, `.` or `..`).
struct Lookup<'p> {
    parent: Option<Idx>,
    name: Name<'p>,
    node: Option<Idx>,
    /// The path ended with `/` or `/.`, so the entry must be a directory.
    dir_tail: bool,
}

impl Lookup<'_> {
    fn at_dir(dir: Idx) -> Self {
        Lookup {
            parent: None,
            name: Name::InPath(&[]),
            node: Some(dir),
            dir_tail: true,
        }
    }
}

/// The last component of a looked-up path, never copied: in the caller's
/// path, or in the text a followed link made (`resolve`), which it keeps. So
/// a lookup allocates nothing unless it follows a link, and removing by a
/// plain path needs no memory at all.
enum Name<'p> {
    InPath(&'p [u8]),
    Spliced(Vec<u8>, core::ops::Range<usize>),
}

impl core::ops::Deref for Name<'_> {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        match self {
            Name::InPath(name) => name,
            Name::Spliced(text, range) => &text[range.clone()],
        }
    }
}

/// A new entry's name, copied before anything changes: once as the
/// directory's key and once as the inode's own (`Inode::name`).
struct Named {
    key: Box<[u8]>,
    name: Box<[u8]>,
}

/// How long a path is (`entry_path_len`).
enum PathLength {
    Fits(usize),
    /// Longer than the limit it was measured against.
    Over,
    /// Not in the tree.
    Detached,
}

/// A directory `mkdirp` made: what undoing it restores.
struct Made {
    dir: Idx,
    parent: Idx,
    /// The parent's times before the directory was made in it.
    mtime: f64,
    ctime: f64,
}

/// The counters a call that is undone gives back (`undo_mkdirp`).
#[derive(Clone, Copy)]
struct Mark {
    events: usize,
    events_dropped: bool,
    next_ino: u64,
    next_seq: u64,
}

/// A directory `remove_tree` is removing the contents of, with its entries
/// taken out of its map.
struct Level {
    dir: Idx,
    /// The entries not yet removed, the last made first: the next one is
    /// popped from the end.
    children: Vec<(Box<[u8]>, Entry)>,
}

/// What `open_handle` opens for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Opening {
    /// A handle `open` gives out: it needs a slot in the table.
    Handle,
    /// A `writeFile` of this many bytes, which closes it again.
    Write(usize),
}

/// What an open does once its checks pass.
enum Target {
    /// Makes a file in this directory.
    Create(Idx),
    /// Opens this node.
    Existing(Idx),
}

/// An open file or directory (`VfsFile`).
#[derive(Clone, Copy)]
struct Handle {
    node: Idx,
    flags: u32,
    offset: f64,
}

/// A caller-supplied creation mode with the umask applied, or the default.
pub fn creation_mode(mode: f64, fallback: u32) -> u32 {
    if !js::is_integer(mode) || mode < 0.0 {
        return fallback;
    }
    (js::to_int32(mode) as u32) & 0o7777 & !UMASK
}

/// Grows a file's buffer to hold at least `needed` bytes, doubling as
/// `inode.ts` `reserve` does so that appends stay amortized. Fails instead of
/// aborting when memory runs out, and when the growth would leave less than
/// `HEADROOM`: file data must never take what the tree needs to change.
fn reserve(
    space: &mut impl Space,
    data: &mut Vec<u8>,
    needed: usize,
) -> core::result::Result<(), ()> {
    let current = data.len();
    let doubled = if current == 0 {
        needed
    } else {
        needed.max(current.saturating_mul(2))
    };
    // The doubled buffer is only an optimisation: a file that still fits
    // without it must not fail for want of it.
    for capacity in [doubled, needed] {
        if data.try_reserve_exact(capacity - current).is_ok() {
            if space.can_allocate(HEADROOM) {
                data.resize(capacity, 0);
                return Ok(());
            }
            // Back to what it was; shrinking happens in place.
            data.shrink_to(current);
        }
        if capacity == needed {
            break;
        }
    }
    Err(())
}

/// The whole filesystem. It owns everything and has no global state.
///
/// Running out of memory is an error, never an abort (`HEADROOM`): what an
/// operation needs is had, or checked for, before it changes the tree, so an
/// ENOSPC leaves the tree as it was. Removing, truncating to less, closing and
/// reading never need it.
pub struct Fs<C: Clock, S: Space = Unlimited> {
    pub clock: C,
    pub space: S,
    /// Whether any watch exists (`watchers.active`): events are logged only then.
    pub watching: bool,
    inodes: Vec<Option<Inode>>,
    /// Its capacity is kept at least the table's length less the root, so
    /// that freeing a slot never allocates.
    free_inodes: Vec<Idx>,
    root: Idx,
    handles: Vec<Option<Handle>>,
    /// Its capacity is kept at least the table's length, so that closing
    /// never allocates.
    free_handles: Vec<u32>,
    next_ino: u64,
    next_seq: u64,
    inode_count: u64,
    byte_count: u64,
    events: Vec<u8>,
    events_dropped: bool,
    /// The bytes a call returns when they are not a file's own (a listing, a path).
    out: Vec<u8>,
}

impl<C: Clock> Fs<C, Unlimited> {
    pub fn new(clock: C) -> Self {
        Fs::with_space(clock, Unlimited)
    }
}

impl<C: Clock, S: Space> Fs<C, S> {
    pub fn with_space(clock: C, space: S) -> Self {
        let mut fs = Fs {
            clock,
            space,
            watching: false,
            inodes: Vec::new(),
            free_inodes: Vec::new(),
            root: 0,
            handles: Vec::new(),
            free_handles: Vec::new(),
            next_ino: 1,
            next_seq: 0,
            inode_count: 0,
            byte_count: 0,
            events: Vec::new(),
            events_dropped: false,
            out: Vec::new(),
        };
        let t = fs.clock.now();
        let root = fs.new_dir(DEFAULT_DIR_MODE, t);
        fs.node_mut(root).parent = Some(root);
        fs.root = root;
        fs
    }

    /// Gives back the memory a large result (a listing, a path) left in the
    /// scratch buffer, which is otherwise kept for the next one: called as a
    /// call begins, once the caller has copied the last result out, so that
    /// a big listing does not hold memory the files need.
    pub fn trim_scratch(&mut self) {
        if self.out.capacity() > SCRATCH_KEPT {
            self.out = Vec::new();
        }
    }

    /// Live inodes and the bytes their files hold.
    pub fn totals(&self) -> (u64, u64) {
        (self.inode_count, self.byte_count)
    }

    pub fn stat(&self, path: &[u8], follow: bool) -> Result<Stat> {
        let syscall = if follow {
            Syscall::Stat
        } else {
            Syscall::Lstat
        };
        let node = self.existing(path, follow, syscall)?;
        Ok(self.stat_of(node))
    }

    pub fn exists(&self, path: &[u8]) -> bool {
        matches!(self.resolve(path, true), Ok(Lookup { node: Some(_), .. }))
    }

    /// The listing (`[kind][length u32 LE][name]` per entry) and how many entries it has.
    pub fn readdir(&mut self, path: &[u8]) -> Result<(&[u8], u32)> {
        let node = self.existing(path, true, Syscall::Scandir)?;
        let mut out = core::mem::take(&mut self.out);
        out.clear();
        let Kind::Dir(entries) = &self.node(node).kind else {
            self.out = out;
            return fail(Errno::Enotdir, Syscall::Scandir, PATH_FIRST);
        };
        let count = entries.len() as u32;
        for (name, entry) in entries {
            let kind = match self.node(entry.node).kind {
                Kind::File(_) => KIND_FILE,
                Kind::Dir(_) => KIND_DIR,
                Kind::Symlink(_) => KIND_SYMLINK,
            };
            // The buffer is kept between calls, so this rarely grows it.
            if out.try_reserve(5 + name.len()).is_err() {
                self.out = out;
                return fail(Errno::Enospc, Syscall::Scandir, PATH_FIRST);
            }
            out.push(kind);
            out.extend_from_slice(&(name.len() as u32).to_le_bytes());
            out.extend_from_slice(name);
        }
        self.out = out;
        Ok((&self.out, count))
    }

    /// Returns the first directory it created when `recursive`, else None.
    pub fn mkdir(&mut self, path: &[u8], recursive: bool, mode: f64) -> Result<Option<&[u8]>> {
        let perm = creation_mode(mode, DEFAULT_DIR_MODE);
        if !recursive {
            let found = self.lookup(path, false, Syscall::Mkdir, PATH_FIRST)?;
            self.create_dir(found, perm, Syscall::Mkdir)?;
            return Ok(None);
        }
        // The first directory made is a prefix of the path: room for it is
        // made first, so that nothing is made that could not be reported.
        self.out.clear();
        if self.out.try_reserve(path.len()).is_err() {
            return fail(Errno::Enospc, Syscall::Mkdir, PATH_FIRST);
        }
        let Some(first) = self.mkdirp(path::trim_trailing_slashes(path), perm)? else {
            return Ok(None);
        };
        self.out.extend_from_slice(first);
        Ok(Some(&self.out))
    }

    pub fn rmdir(&mut self, path: &[u8]) -> Result<()> {
        let found = self.lookup(path, false, Syscall::Rmdir, PATH_FIRST)?;
        let Some(node) = found.node else {
            return fail(Errno::Enoent, Syscall::Rmdir, PATH_FIRST);
        };
        // As Linux, by the path's own last part: `.` cannot be removed, and
        // `..` is never empty (it holds the path walked through it).
        match path::last_part(path) {
            b"." => return fail(Errno::Einval, Syscall::Rmdir, PATH_FIRST),
            b".." => return fail(Errno::Enotempty, Syscall::Rmdir, PATH_FIRST),
            _ => {}
        }
        if node == self.root {
            return fail(Errno::Ebusy, Syscall::Rmdir, PATH_FIRST);
        }
        let Some(parent) = found.parent else {
            return fail(Errno::Einval, Syscall::Rmdir, PATH_FIRST);
        };
        let Kind::Dir(entries) = &self.node(node).kind else {
            return fail(Errno::Enotdir, Syscall::Rmdir, PATH_FIRST);
        };
        if !entries.is_empty() {
            return fail(Errno::Enotempty, Syscall::Rmdir, PATH_FIRST);
        }
        self.remove_entry(parent, &found.name, node, true);
        Ok(())
    }

    pub fn unlink(&mut self, path: &[u8]) -> Result<()> {
        let found = self.lookup(path, false, Syscall::Unlink, PATH_FIRST)?;
        let Some(node) = found.node else {
            return fail(Errno::Enoent, Syscall::Unlink, PATH_FIRST);
        };
        let parent = match found.parent {
            Some(parent) if !self.node(node).is_dir() => parent,
            _ => return fail(Errno::Eisdir, Syscall::Unlink, PATH_FIRST),
        };
        self.remove_entry(parent, &found.name, node, true);
        Ok(())
    }

    pub fn rm(&mut self, path: &[u8], recursive: bool, force: bool) -> Result<()> {
        let found = match self.resolve(path, false) {
            Ok(found) => found,
            Err(Errno::Enoent) if force => return Ok(()),
            Err(code) => return fail(code, Syscall::Rm, PATH_FIRST),
        };
        let Some(node) = found.node else {
            if force {
                return Ok(());
            }
            return fail(Errno::Enoent, Syscall::Rm, PATH_FIRST);
        };
        if node == self.root {
            return fail(Errno::Ebusy, Syscall::Rm, PATH_FIRST);
        }
        if self.node(node).is_dir() {
            if !recursive {
                return fail(Errno::Eisdir, Syscall::Rm, PATH_FIRST);
            }
            if found.parent.is_none() {
                return fail(Errno::Einval, Syscall::Rm, PATH_FIRST);
            }
            self.remove_tree(node);
        }
        let Some(parent) = found.parent else {
            return fail(Errno::Einval, Syscall::Rm, PATH_FIRST);
        };
        self.remove_entry(parent, &found.name, node, true);
        Ok(())
    }

    pub fn rename(&mut self, from: &[u8], to: &[u8]) -> Result<()> {
        const RENAME: Syscall = Syscall::Rename;
        let source = self.lookup(from, false, RENAME, PATH_BOTH)?;
        let Some(node) = source.node else {
            return fail(Errno::Enoent, RENAME, PATH_BOTH);
        };
        if node == self.root {
            return fail(Errno::Ebusy, RENAME, PATH_BOTH);
        }
        let Some(source_parent) = source.parent else {
            return fail(Errno::Einval, RENAME, PATH_BOTH);
        };
        let target = self.lookup(to, false, RENAME, PATH_BOTH)?;
        if target.node == Some(self.root) {
            return fail(Errno::Ebusy, RENAME, PATH_BOTH);
        }
        let Some(target_parent) = target.parent else {
            return fail(Errno::Einval, RENAME, PATH_BOTH);
        };
        if target.node == Some(node) {
            return Ok(());
        }
        let moving_dir = self.node(node).is_dir();
        // A trailing slash names a directory; only one can take that name.
        // (A last part of `.` is another case, left as it was.)
        if target.dir_tail && !moving_dir && path::last_part(to) != b"." {
            return fail(Errno::Enotdir, RENAME, PATH_BOTH);
        }
        if moving_dir && self.is_within(target_parent, node) {
            return fail(Errno::Einval, RENAME, PATH_BOTH);
        }
        let replaced = target.node;
        if let Some(replaced) = replaced {
            match &self.node(replaced).kind {
                Kind::Dir(entries) if moving_dir => {
                    if !entries.is_empty() {
                        return fail(Errno::Enotempty, RENAME, PATH_BOTH);
                    }
                }
                _ if moving_dir => return fail(Errno::Enotdir, RENAME, PATH_BOTH),
                Kind::Dir(_) => return fail(Errno::Eisdir, RENAME, PATH_BOTH),
                _ => {}
            }
        }
        let old_path = if self.watching {
            self.event_path(source_parent, &source.name)
        } else {
            Ok(None)
        };
        self.room(RENAME, PATH_BOTH)?;
        let key = boxed(&target.name).map_err(|_| no_space(RENAME, PATH_BOTH))?;
        let primary = {
            let moving = self.node(node);
            moving.parent == Some(source_parent) && *moving.name == *source.name
        };
        let name = if primary {
            Some(boxed(&target.name).map_err(|_| no_space(RENAME, PATH_BOTH))?)
        } else {
            None
        };
        let t = self.clock.now();
        if let Some(replaced) = replaced {
            self.remove_entry(target_parent, &target.name, replaced, false);
        }
        self.entries_mut(source_parent).remove(&source.name[..]);
        self.insert_entry(target_parent, key, node);
        if moving_dir && source_parent != target_parent {
            self.node_mut(source_parent).nlink -= 1;
            self.node_mut(target_parent).nlink += 1;
        }
        let moved = self.node_mut(node);
        if let Some(name) = name {
            moved.parent = Some(target_parent);
            moved.name = name;
        }
        moved.ctime = t;
        self.touch(source_parent, t);
        self.touch(target_parent, t);
        match old_path {
            Ok(Some(old_path)) => self.log_event(EVENT_RENAME, &old_path),
            Ok(None) => {}
            Err(()) => self.events_dropped = true,
        }
        self.emit_entry(EVENT_RENAME, target_parent, &target.name);
        Ok(())
    }

    pub fn link(&mut self, existing_path: &[u8], new_path: &[u8]) -> Result<()> {
        const LINK: Syscall = Syscall::Link;
        let source = self.lookup(existing_path, false, LINK, PATH_BOTH)?;
        let Some(node) = source.node else {
            return fail(Errno::Enoent, LINK, PATH_BOTH);
        };
        if self.node(node).is_dir() {
            return fail(Errno::Eperm, LINK, PATH_BOTH);
        }
        let target = self.lookup(new_path, false, LINK, PATH_BOTH)?;
        let parent = match target.parent {
            Some(parent) if target.node.is_none() => parent,
            _ => return fail(Errno::Eexist, LINK, PATH_BOTH),
        };
        if target.dir_tail {
            return fail(Errno::Enoent, LINK, PATH_BOTH);
        }
        self.room(LINK, PATH_BOTH)?;
        let key = boxed(&target.name).map_err(|_| no_space(LINK, PATH_BOTH))?;
        let name = if self.node(node).parent.is_none() {
            Some(boxed(&target.name).map_err(|_| no_space(LINK, PATH_BOTH))?)
        } else {
            None
        };
        let t = self.clock.now();
        self.insert_entry(parent, key, node);
        let linked = self.node_mut(node);
        linked.nlink += 1;
        linked.ctime = t;
        if let Some(name) = name {
            linked.parent = Some(parent);
            linked.name = name;
        }
        self.touch(parent, t);
        self.emit_entry(EVENT_RENAME, parent, &target.name);
        Ok(())
    }

    /// Creates `path` as a link to `target`.
    pub fn symlink(&mut self, target: &[u8], path: &[u8]) -> Result<()> {
        let found = self.lookup(path, false, Syscall::Symlink, PATH_BOTH)?;
        let parent = match found.parent {
            Some(parent) if found.node.is_none() => parent,
            _ => return fail(Errno::Eexist, Syscall::Symlink, PATH_BOTH),
        };
        if found.dir_tail || target.is_empty() {
            return fail(Errno::Enoent, Syscall::Symlink, PATH_BOTH);
        }
        let named = self.prepare(&found.name, Syscall::Symlink, PATH_BOTH)?;
        let target = boxed(target).map_err(|_| no_space(Syscall::Symlink, PATH_BOTH))?;
        let t = self.clock.now();
        let node = self.new_inode(0o777, t, 1, Kind::Symlink(target));
        self.add_entry(parent, &found.name, named, node, t);
        Ok(())
    }

    pub fn readlink(&self, path: &[u8]) -> Result<&[u8]> {
        let node = self.existing(path, false, Syscall::Readlink)?;
        match &self.node(node).kind {
            Kind::Symlink(target) => Ok(target),
            _ => fail(Errno::Einval, Syscall::Readlink, PATH_FIRST),
        }
    }

    pub fn realpath(&mut self, path: &[u8]) -> Result<&[u8]> {
        let found = self.lookup(path, true, Syscall::Realpath, PATH_FIRST)?;
        let Some(node) = found.node else {
            return fail(Errno::Enoent, Syscall::Realpath, PATH_FIRST);
        };
        self.found_path(&found, node, Syscall::Realpath)
    }

    pub fn chmod(&mut self, path: &[u8], mode: u32, follow: bool) -> Result<()> {
        let found = self.lookup(path, follow, Syscall::Chmod, PATH_FIRST)?;
        let Some(node) = found.node else {
            return fail(Errno::Enoent, Syscall::Chmod, PATH_FIRST);
        };
        if self.node(node).is_symlink() {
            // Linux cannot change a link's own mode (fchmodat AT_SYMLINK_NOFOLLOW).
            return fail(Errno::Enotsup, Syscall::Chmod, PATH_FIRST);
        }
        self.set_mode(node, mode);
        self.emit_found(EVENT_CHANGE, &found);
        Ok(())
    }

    pub fn utimes(&mut self, path: &[u8], atime: f64, mtime: f64, follow: bool) -> Result<()> {
        let found = self.lookup(path, follow, Syscall::Utime, PATH_FIRST)?;
        let Some(node) = found.node else {
            return fail(Errno::Enoent, Syscall::Utime, PATH_FIRST);
        };
        self.set_times(node, atime, mtime);
        self.emit_found(EVENT_CHANGE, &found);
        Ok(())
    }

    pub fn truncate(&mut self, path: &[u8], length: f64) -> Result<()> {
        let found = self.lookup(path, true, Syscall::Open, PATH_FIRST)?;
        let Some(node) = found.node else {
            return fail(Errno::Enoent, Syscall::Open, PATH_FIRST);
        };
        if self.node(node).is_dir() {
            return fail(Errno::Eisdir, Syscall::Open, PATH_FIRST);
        }
        if !self.node(node).is_file() || length < 0.0 || !length.is_finite() {
            return fail(Errno::Einval, Syscall::Ftruncate, PATH_NONE);
        }
        if length > MAX_FILE_SIZE {
            return fail(Errno::Efbig, Syscall::Ftruncate, PATH_NONE);
        }
        self.resize_data(node, js::floor(length) as u64)?;
        self.emit_found(EVENT_CHANGE, &found);
        Ok(())
    }

    /// `mode` is `COPYFILE_EXCL` or 0.
    pub fn copy_file(&mut self, source: &[u8], destination: &[u8], mode: u32) -> Result<()> {
        const COPY: Syscall = Syscall::Copyfile;
        let from = self.lookup(source, true, COPY, PATH_BOTH)?;
        let Some(node) = from.node else {
            return fail(Errno::Enoent, COPY, PATH_BOTH);
        };
        let Kind::File(file) = &self.node(node).kind else {
            return fail(Errno::Eisdir, COPY, PATH_BOTH);
        };
        let size = file.size;
        let perm = self.node(node).perm;
        let exclusive = mode & COPYFILE_EXCL != 0;
        let to = self.lookup(destination, !exclusive, COPY, PATH_BOTH)?;
        if to.node.is_some() && exclusive {
            return fail(Errno::Eexist, COPY, PATH_BOTH);
        }
        if to.node == Some(node) {
            return Ok(());
        }
        let parent = match to.parent {
            Some(parent) if !to.node.is_some_and(|existing| self.node(existing).is_dir()) => parent,
            _ => return fail(Errno::Eisdir, COPY, PATH_BOTH),
        };
        let Some(existing) = to.node else {
            if to.dir_tail {
                return fail(Errno::Eisdir, COPY, PATH_BOTH);
            }
            // The room for the copy is made before anything changes, so that
            // running out of memory leaves no half-made file behind.
            let named = self.prepare(&to.name, COPY, PATH_BOTH)?;
            let mut data = Vec::new();
            if size > 0 {
                reserve(&mut self.space, &mut data, size).map_err(|_| no_space(COPY, PATH_BOTH))?;
            }
            let t = self.clock.now();
            let copy = self.new_inode(perm, t, 1, Kind::File(FileData { data, size: 0 }));
            self.write_data(copy, size, 0.0)?;
            self.copy_bytes(node, copy, size);
            self.add_entry(parent, &to.name, named, copy, t);
            return Ok(());
        };
        if !self.node(existing).is_file() {
            return fail(Errno::Einval, COPY, PATH_BOTH);
        }
        // As above: once the destination is emptied the copy must not fail.
        if size > self.file(existing).data.len() {
            self.grow_data(existing, size)
                .map_err(|_| no_space(COPY, PATH_BOTH))?;
        }
        self.resize_data(existing, 0)?;
        self.write_data(existing, size, 0.0)?;
        self.copy_bytes(node, existing, size);
        self.set_mode(existing, perm);
        self.emit_found(EVENT_CHANGE, &to);
        Ok(())
    }

    /// `mode` is a mask of `F_OK`, `R_OK`, `W_OK`, `X_OK`.
    pub fn access(&self, path: &[u8], mode: u32) -> Result<()> {
        let node = self.node(self.existing(path, true, Syscall::Access)?);
        if mode & X_OK != 0 && node.is_file() && node.perm & 0o111 == 0 {
            return fail(Errno::Eacces, Syscall::Access, PATH_FIRST);
        }
        Ok(())
    }

    /// One attempt of `mkdtemp`: makes the directory `path` (the prefix plus
    /// six random characters, chosen by the caller) and returns true, or
    /// returns false when the name is taken. Errors name the caller's
    /// `prefixXXXXXX`, given as the first path.
    pub fn mkdtemp(&mut self, path: &[u8]) -> Result<bool> {
        let found = match self.resolve(path, false) {
            Ok(found) => found,
            Err(code) => return fail(code, Syscall::Mkdtemp, PATH_FIRST),
        };
        if found.node.is_some() {
            return Ok(false);
        }
        if found.parent.is_none() {
            return fail(Errno::Eexist, Syscall::Mkdtemp, PATH_FIRST);
        }
        self.create_dir(found, 0o700, Syscall::Mkdtemp)?;
        Ok(true)
    }

    /// The whole file, in the file's own buffer.
    pub fn read_file(&mut self, path: &[u8]) -> Result<&[u8]> {
        let node = self.existing(path, true, Syscall::Open)?;
        match self.node(node).kind {
            Kind::Dir(_) => return fail(Errno::Eisdir, Syscall::Read, PATH_NONE),
            Kind::Symlink(_) => return fail(Errno::Einval, Syscall::Read, PATH_NONE),
            Kind::File(_) => {}
        }
        let t = self.clock.now();
        self.node_mut(node).atime = t;
        let file = self.file(node);
        Ok(&file.data[..file.size])
    }

    /// `writeFile` of `length` bytes: everything but copying them, which the
    /// caller does into the slice returned.
    pub fn write_file(
        &mut self,
        path: &[u8],
        flags: u32,
        mode: f64,
        length: usize,
    ) -> Result<&mut [u8]> {
        // Everything that can run short (the new file's buffer, the
        // truncated file's growth) is had inside the open, before it changes
        // anything, so the write below cannot fail for memory.
        let mut handle = self.open_handle(path, flags, mode, Opening::Write(length))?;
        let written = if length > 0 {
            self.write_through(&mut handle, length, f64::NAN)
        } else {
            Ok(0)
        };
        self.file_closed(handle.node);
        let start = written?;
        Ok(self.file_bytes_mut(handle.node, start, length))
    }

    /// Opens `path` and returns its handle.
    pub fn open(&mut self, path: &[u8], flags: u32, mode: f64) -> Result<u32> {
        let handle = self.open_handle(path, flags, mode, Opening::Handle)?;
        Ok(match self.free_handles.pop() {
            Some(number) => {
                self.handles[number as usize] = Some(handle);
                number
            }
            None => {
                self.handles.push(Some(handle));
                (self.handles.len() - 1) as u32
            }
        })
    }

    /// The path a watch on `path` follows: where it really is.
    pub fn watch_path(&mut self, path: &[u8]) -> Result<&[u8]> {
        let found = self.lookup(path, true, Syscall::Watch, PATH_FIRST)?;
        let Some(node) = found.node else {
            return fail(Errno::Enoent, Syscall::Watch, PATH_FIRST);
        };
        self.found_path(&found, node, Syscall::Watch)
    }

    // ---- open files (VfsFile) ----

    /// Reads up to `length` bytes at `position`, or at the handle's offset
    /// (advancing it) when `position` is NaN. Returns them in the file's buffer.
    pub fn handle_read(&mut self, number: u32, length: f64, position: f64) -> Result<&[u8]> {
        let mut handle = self.handle(number, Syscall::Read)?;
        if handle.flags & O_ACCMODE == O_WRONLY {
            return fail(Errno::Ebadf, Syscall::Read, PATH_NONE);
        }
        if self.node(handle.node).is_dir() {
            return fail(Errno::Eisdir, Syscall::Read, PATH_NONE);
        }
        let at = if position.is_nan() {
            handle.offset
        } else {
            position
        };
        let file = self.file(handle.node);
        let (start, end) = read_range(file.size, file.data.len(), length, at);
        if position.is_nan() {
            handle.offset = at + (end - start) as f64;
            self.handles[number as usize] = Some(handle);
        }
        let t = self.clock.now();
        self.node_mut(handle.node).atime = t;
        Ok(&self.file(handle.node).data[start..end])
    }

    /// Everything a write of `length` bytes does but copying them, which the
    /// caller does into the slice returned. `position` NaN writes at the offset.
    pub fn handle_write(&mut self, number: u32, length: usize, position: f64) -> Result<&mut [u8]> {
        let mut handle = self.handle(number, Syscall::Write)?;
        let start = self.write_through(&mut handle, length, position)?;
        self.handles[number as usize] = Some(handle);
        Ok(self.file_bytes_mut(handle.node, start, length))
    }

    pub fn handle_stat(&self, number: u32) -> Result<Stat> {
        let handle = self.handle(number, Syscall::Fstat)?;
        Ok(self.stat_of(handle.node))
    }

    pub fn handle_truncate(&mut self, number: u32, length: f64) -> Result<()> {
        let handle = self.handle(number, Syscall::Ftruncate)?;
        if self.node(handle.node).is_dir()
            || handle.flags & O_ACCMODE == O_RDONLY
            || length < 0.0
            || !length.is_finite()
        {
            return fail(Errno::Einval, Syscall::Ftruncate, PATH_NONE);
        }
        if length > MAX_FILE_SIZE {
            return fail(Errno::Efbig, Syscall::Ftruncate, PATH_NONE);
        }
        self.resize_data(handle.node, js::floor(length) as u64)?;
        self.emit_node(EVENT_CHANGE, handle.node);
        Ok(())
    }

    pub fn handle_chmod(&mut self, number: u32, mode: u32) -> Result<()> {
        let handle = self.handle(number, Syscall::Fchmod)?;
        self.set_mode(handle.node, mode);
        self.emit_node(EVENT_CHANGE, handle.node);
        Ok(())
    }

    pub fn handle_utimes(&mut self, number: u32, atime: f64, mtime: f64) -> Result<()> {
        let handle = self.handle(number, Syscall::Futime)?;
        self.set_times(handle.node, atime, mtime);
        self.emit_node(EVENT_CHANGE, handle.node);
        Ok(())
    }

    pub fn handle_close(&mut self, number: u32) -> Result<()> {
        let handle = self.handle(number, Syscall::Close)?;
        self.handles[number as usize] = None;
        self.free_handles.push(number);
        self.file_closed(handle.node);
        Ok(())
    }

    // ---- the event log ----

    /// Entries of `[type u8][length u32 LE][path]`, oldest first.
    pub fn events(&self) -> &[u8] {
        &self.events
    }

    /// Whether events were dropped since the log was last cleared.
    pub fn events_dropped(&self) -> bool {
        self.events_dropped
    }

    pub fn clear_events(&mut self) {
        self.events.clear();
        // A burst can leave a log of megabytes: give them back to the files.
        if self.events.capacity() > EVENTS_KEPT {
            self.events = Vec::new();
        }
        self.events_dropped = false;
    }

    // ---- path resolution ----

    /// Walks `path` from the root, following symbolic links in every
    /// intermediate component and in the last one when `follow_last` (or when
    /// a trailing slash demands a directory). `..` is resolved physically,
    /// after links. A followed link's target is spliced in front of the rest
    /// of the path, as vfs.ts does with its parts, so this is a loop.
    fn resolve<'p>(
        &self,
        path: &'p [u8],
        follow_last: bool,
    ) -> core::result::Result<Lookup<'p>, Errno> {
        if path.is_empty() {
            return Err(Errno::Enoent);
        }
        if path[0] != SLASH {
            return Err(Errno::Einval);
        }
        let mut spliced: Option<Vec<u8>> = None;
        let mut dir = self.root;
        let mut links = 0;
        loop {
            let text: &[u8] = spliced.as_deref().unwrap_or(path);
            let last = path::last_component(text);
            let mut at = 0;
            let next = loop {
                let Some((end_start, end_stop)) = last else {
                    return Ok(Lookup::at_dir(dir));
                };
                if at > end_start {
                    return Ok(Lookup::at_dir(dir));
                }
                let stop = path::part_end(text, at);
                let name = &text[at..stop];
                let following = stop + 1;
                if name.is_empty() || name == b"." {
                    at = following;
                    continue;
                }
                if name == b".." {
                    dir = self.node(dir).parent.unwrap_or(dir);
                    at = following;
                    continue;
                }
                let node = self.entries(dir).get(name).map(|entry| entry.node);
                let link = node.filter(|&found| self.node(found).is_symlink());
                if at == end_start {
                    let dir_tail = end_stop < text.len();
                    if link.is_none() || !(follow_last || dir_tail) {
                        if dir_tail && node.is_some_and(|found| !self.node(found).is_dir()) {
                            return Err(Errno::Enotdir);
                        }
                        let name = match spliced {
                            Some(text) => Name::Spliced(text, at..stop),
                            None => Name::InPath(&path[at..stop]),
                        };
                        return Ok(Lookup {
                            parent: Some(dir),
                            name,
                            node,
                            dir_tail,
                        });
                    }
                } else {
                    match node {
                        None => return Err(Errno::Enoent),
                        Some(found) if self.node(found).is_dir() => {
                            dir = found;
                            at = following;
                            continue;
                        }
                        Some(_) if link.is_none() => return Err(Errno::Enotdir),
                        Some(_) => {}
                    }
                }
                links += 1;
                if links > MAX_LINKS {
                    return Err(Errno::Eloop);
                }
                let Some(Kind::Symlink(target)) = link.map(|found| &self.node(found).kind) else {
                    unreachable!("only a symbolic link is followed");
                };
                if target.first() == Some(&SLASH) {
                    dir = self.root;
                }
                let mut next = Vec::new();
                if next
                    .try_reserve_exact(target.len() + text.len() - stop)
                    .is_err()
                {
                    return Err(Errno::Enospc);
                }
                next.extend_from_slice(target);
                if stop < text.len() {
                    next.extend_from_slice(&text[stop..]);
                }
                break next;
            };
            spliced = Some(next);
        }
    }

    /// `resolve`, turning a failure into one for `syscall`.
    fn lookup<'p>(
        &self,
        path: &'p [u8],
        follow_last: bool,
        syscall: Syscall,
        path_mode: u32,
    ) -> Result<Lookup<'p>> {
        self.resolve(path, follow_last).map_err(|errno| Failure {
            errno,
            syscall,
            path_mode,
        })
    }

    /// The node `path` names, or ENOENT.
    fn existing(&self, path: &[u8], follow_last: bool, syscall: Syscall) -> Result<Idx> {
        match self.lookup(path, follow_last, syscall, PATH_FIRST)?.node {
            Some(node) => Ok(node),
            None => fail(Errno::Enoent, syscall, PATH_FIRST),
        }
    }

    /// Where `found` (naming `node`) really is, in `out`; ENOENT when detached.
    fn found_path(&mut self, found: &Lookup, node: Idx, syscall: Syscall) -> Result<&[u8]> {
        let mut out = core::mem::take(&mut self.out);
        out.clear();
        let attached = match found.parent {
            None => self.dir_path(node, &mut out),
            Some(parent) => self.entry_path_into(parent, &found.name, &mut out),
        };
        self.out = out;
        match attached {
            Ok(true) => Ok(&self.out),
            Ok(false) => fail(Errno::Enoent, syscall, PATH_FIRST),
            Err(NoMemory) => fail(Errno::Enospc, syscall, PATH_FIRST),
        }
    }

    // ---- tree edits ----

    fn new_inode(&mut self, perm: u32, t: f64, nlink: u32, kind: Kind) -> Idx {
        self.inode_count += 1;
        let ino = self.next_ino;
        self.next_ino += 1;
        let inode = Inode {
            ino,
            perm,
            nlink,
            atime: t,
            mtime: t,
            ctime: t,
            birthtime: t,
            parent: None,
            name: Box::default(),
            handles: 0,
            released: false,
            kind,
        };
        match self.free_inodes.pop() {
            Some(slot) => {
                self.inodes[slot as usize] = Some(inode);
                slot
            }
            None => {
                self.inodes.push(Some(inode));
                (self.inodes.len() - 1) as Idx
            }
        }
    }

    fn new_dir(&mut self, perm: u32, t: f64) -> Idx {
        self.new_inode(perm, t, 2, Kind::Dir(BTreeMap::new()))
    }

    /// Fails with ENOSPC, naming `syscall` and `path_mode`, unless `HEADROOM`
    /// is still there: what an operation that adds to the tree asks before it
    /// changes anything.
    fn room(&mut self, syscall: Syscall, path_mode: u32) -> Result<()> {
        if self.space.can_allocate(HEADROOM) {
            Ok(())
        } else {
            Err(no_space(syscall, path_mode))
        }
    }

    /// Makes sure `new_inode` has a slot without allocating: a free one, or
    /// room for one more in the table (and in its free list, so that freeing
    /// it later allocates nothing either).
    fn reserve_inode(&mut self) -> bool {
        if !self.free_inodes.is_empty() {
            return true;
        }
        let slots = self.inodes.len();
        grow(&mut self.space, &mut self.inodes, 1)
            && grow(&mut self.space, &mut self.free_inodes, slots + 1)
    }

    /// Everything a new inode linked in as `name` needs that can run short,
    /// had before anything changes: the headroom, the inode's slot, the
    /// entry's key and the inode's own copy of its name.
    fn prepare(&mut self, name: &[u8], syscall: Syscall, path_mode: u32) -> Result<Named> {
        self.room(syscall, path_mode)?;
        if !self.reserve_inode() {
            return Err(no_space(syscall, path_mode));
        }
        let key = boxed(name).map_err(|_| no_space(syscall, path_mode))?;
        let name = boxed(name).map_err(|_| no_space(syscall, path_mode))?;
        Ok(Named { key, name })
    }

    /// Sets the entry `key` in `parent` to `node`, as a new entry.
    fn insert_entry(&mut self, parent: Idx, key: Box<[u8]>, node: Idx) {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.entries_mut(parent).insert(key, Entry { node, seq });
    }

    /// Links a newly created `node` into `parent` as `name`, with the copies
    /// of it `prepare` made.
    fn add_entry(&mut self, parent: Idx, name: &[u8], named: Named, node: Idx, t: f64) {
        self.insert_entry(parent, named.key, node);
        let added = self.node_mut(node);
        added.parent = Some(parent);
        added.name = named.name;
        if added.is_dir() {
            self.node_mut(parent).nlink += 1;
        }
        self.touch(parent, t);
        self.emit_entry(EVENT_RENAME, parent, name);
    }

    /// Removes the entry `name` (naming `node`) from `parent`, freeing the node
    /// once nothing refers to it. The entry may already be out of the map
    /// (`remove_tree`). Allocates nothing that can abort.
    fn remove_entry(&mut self, parent: Idx, name: &[u8], node: Idx, notify: bool) {
        // Its event is the same logged before the removal as after: the
        // removal does not change where `parent` is, and logs nothing else.
        if notify {
            self.emit_entry(EVENT_RENAME, parent, name);
        }
        let t = self.clock.now();
        self.entries_mut(parent).remove(name);
        self.touch(parent, t);
        if self.node(node).is_dir() {
            self.node_mut(parent).nlink -= 1;
            let removed = self.node_mut(node);
            removed.nlink = 0;
            removed.parent = None;
            self.release(node);
        } else {
            let removed = self.node_mut(node);
            removed.nlink -= 1;
            removed.ctime = t;
            if removed.parent == Some(parent) && *removed.name == *name {
                removed.parent = None;
            }
            if removed.nlink == 0 && (!removed.is_file() || removed.handles == 0) {
                self.release(node);
            }
        }
    }

    /// Removes everything below `top`, deepest first: vfs.ts's recursion is a
    /// walk down the tree and back up by the parent links here, a loop, so
    /// the stack does not grow with the depth. A directory's own entry is
    /// removed when its contents are gone, so its event comes after theirs.
    ///
    /// Each directory's entries are taken out of its map as they are reached
    /// (`remove_entry` allows an entry already out of it), and removed in the
    /// order they were made, as vfs.ts iterates its Map: when the memory for
    /// it can be had, the whole map is moved into a `Level` and sorted once.
    ///
    /// It must work with no memory left, since removing is how memory is had
    /// again. When a level cannot be had, the directory's entries are taken
    /// straight out of its map, in the order of their NAMES, one at a time,
    /// which needs no memory. Only then do the events of that removal come in
    /// another order than vfs.ts's: the set of events is the same, and each
    /// directory's still comes after its contents'. Either way each entry
    /// costs one removal from the map: no lookup, no scan.
    fn remove_tree(&mut self, top: Idx) {
        let mut levels: Vec<Level> = Vec::new();
        let mut dir = top;
        self.enter_level(&mut levels, dir);
        loop {
            let next = match levels.last_mut() {
                Some(level) if level.dir == dir => level.children.pop(),
                _ => self.entries_mut(dir).pop_first(),
            };
            match next {
                Some((_, entry)) if self.node(entry.node).is_dir() => {
                    // Its entry is removed, with the name the node keeps, once
                    // its contents are gone; the key goes now.
                    dir = entry.node;
                    self.enter_level(&mut levels, dir);
                }
                Some((name, entry)) => self.remove_entry(dir, &name, entry.node, true),
                None => {
                    if levels.last().is_some_and(|level| level.dir == dir) {
                        levels.pop();
                    }
                    if dir == top {
                        break;
                    }
                    let Some(parent) = self.node(dir).parent else {
                        unreachable!("a directory in the tree has a parent");
                    };
                    // Its name is taken, not copied: the node is freed with it.
                    let name = core::mem::take(&mut self.node_mut(dir).name);
                    self.remove_entry(parent, &name, dir, true);
                    dir = parent;
                }
            }
        }
    }

    /// Moves `dir`'s entries out of its map into a new level, sorted in the
    /// order they were made, when the memory for it can be had; else leaves
    /// `levels` and the map as they are, and `remove_tree` takes the entries
    /// out of the map one at a time.
    fn enter_level(&mut self, levels: &mut Vec<Level>, dir: Idx) {
        let count = self.entries(dir).len();
        let mut children = Vec::new();
        if count == 0
            || !self
                .space
                .can_allocate(count * size_of::<(Box<[u8]>, Entry)>())
            || levels.try_reserve(1).is_err()
            || children.try_reserve_exact(count).is_err()
        {
            return;
        }
        // The map's nodes are freed as it is emptied.
        children.extend(core::mem::take(self.entries_mut(dir)));
        children.sort_unstable_by_key(|(_, entry)| core::cmp::Reverse(entry.seq));
        levels.push(Level { dir, children });
    }

    fn release(&mut self, node: Idx) {
        self.inode_count -= 1;
        let released = self.node_mut(node);
        let mut freed = 0;
        if let Kind::File(file) = &mut released.kind {
            freed = file.size as u64;
            file.size = 0;
            file.data = Vec::new();
        }
        released.released = true;
        let unused = released.handles == 0;
        self.byte_count -= freed;
        if unused {
            self.inodes[node as usize] = None;
            self.free_inodes.push(node);
        }
    }

    /// Makes the directory `found` names; returns it.
    fn create_dir(&mut self, found: Lookup, perm: u32, syscall: Syscall) -> Result<Idx> {
        let parent = match found.parent {
            Some(parent) if found.node.is_none() => parent,
            _ => return fail(Errno::Eexist, syscall, PATH_FIRST),
        };
        let named = self.prepare(&found.name, syscall, PATH_FIRST)?;
        let t = self.clock.now();
        let dir = self.new_dir(perm, t);
        self.add_entry(parent, &found.name, named, dir, t);
        Ok(dir)
    }

    /// `mkdir -p` the way libuv does it: try the directory, and on ENOENT make
    /// its textual parent first. Returns the first directory created. The
    /// recursion of vfs.ts is two loops here: up to the first ancestor that
    /// resolves, then back down making each one.
    ///
    /// A 64 KiB path can name tens of thousands of directories, far more than
    /// `HEADROOM` holds, so each one asks for it again. When one cannot be
    /// made for lack of memory, the call is undone exactly (`undo_mkdirp`):
    /// ENOSPC leaves everything as it was. How many directories a call makes
    /// is not known up front (it climbs through `..` and symbolic links), so
    /// their memory cannot all be had first.
    fn mkdirp<'p>(&mut self, path: &'p [u8], perm: u32) -> Result<Option<&'p [u8]>> {
        let no_space = || no_space(Syscall::Mkdir, PATH_FIRST);
        let mark = self.mark();
        // The paths still to make, the requested one first.
        let mut pending: Vec<&'p [u8]> = Vec::new();
        // The directories made, for undoing them.
        let mut made: Vec<Made> = Vec::new();
        let mut current = path;
        let first = loop {
            let resolved = self.resolve(current, true);
            if !matches!(&resolved, Ok(Lookup { node: Some(_), .. })) && self.is_link(current) {
                // A symbolic link that leads nowhere: mkdir(2) does not make
                // its target, so `mkdir -p` stops here, as on Linux.
                return fail(Errno::Eexist, Syscall::Mkdir, PATH_FIRST);
            }
            match resolved {
                Ok(found) => {
                    if let Some(node) = found.node {
                        if self.node(node).is_dir() {
                            break None;
                        }
                        return fail(not_a_dir(pending.is_empty()), Syscall::Mkdir, PATH_FIRST);
                    }
                    // Room for every directory the way down may make.
                    if made.try_reserve_exact(pending.len() + 1).is_err() {
                        return Err(no_space());
                    }
                    // Nothing is made yet: a failure here changed nothing.
                    self.make_dir(found, perm, &mut made)?;
                    break Some(current);
                }
                Err(code) => {
                    if code != Errno::Enoent || current == b"/" {
                        return fail(code, Syscall::Mkdir, PATH_FIRST);
                    }
                    if pending.try_reserve(1).is_err() {
                        return Err(no_space());
                    }
                    pending.push(current);
                    current = path::lexical_parent(current);
                }
            }
        };
        if made.try_reserve_exact(pending.len()).is_err() {
            // Only reachable with nothing made: the first loop reserved this.
            self.undo_mkdirp(&mut made, mark);
            return Err(no_space());
        }
        let mut first = first;
        while let Some(current) = pending.pop() {
            match self.mkdirp_step(current, pending.is_empty(), perm, &mut made) {
                Ok(true) => first = first.or(Some(current)),
                Ok(false) => {}
                Err(failure) => {
                    if failure.errno == Errno::Enospc {
                        self.undo_mkdirp(&mut made, mark);
                    }
                    return Err(failure);
                }
            }
        }
        Ok(first)
    }

    /// Whether `path` itself (its last part, not followed) is a symbolic link.
    fn is_link(&self, path: &[u8]) -> bool {
        matches!(
            self.resolve(path, false),
            Ok(Lookup { node: Some(node), .. }) if self.node(node).is_symlink()
        )
    }

    /// One directory of `mkdirp` on the way down: true when made, false when
    /// it is there already.
    fn mkdirp_step(
        &mut self,
        path: &[u8],
        requested: bool,
        perm: u32,
        made: &mut Vec<Made>,
    ) -> Result<bool> {
        let again = self.lookup(path, true, Syscall::Mkdir, PATH_FIRST)?;
        if let Some(node) = again.node {
            if !self.node(node).is_dir() {
                return fail(not_a_dir(requested), Syscall::Mkdir, PATH_FIRST);
            }
            return Ok(false);
        }
        self.make_dir(again, perm, made)?;
        Ok(true)
    }

    /// `create_dir` for `mkdirp`, recording what undoing it needs in `made`,
    /// which has room for it.
    fn make_dir(&mut self, found: Lookup, perm: u32, made: &mut Vec<Made>) -> Result<()> {
        let Some(parent) = found.parent else {
            return fail(Errno::Eexist, Syscall::Mkdir, PATH_FIRST);
        };
        let (mtime, ctime) = {
            let before = self.node(parent);
            (before.mtime, before.ctime)
        };
        let dir = self.create_dir(found, perm, Syscall::Mkdir)?;
        debug_assert!(made.len() < made.capacity());
        made.push(Made {
            dir,
            parent,
            mtime,
            ctime,
        });
        Ok(())
    }

    /// What a call that may have to be undone restores (`undo_mkdirp`).
    fn mark(&self) -> Mark {
        Mark {
            events: self.events.len(),
            events_dropped: self.events_dropped,
            next_ino: self.next_ino,
            next_seq: self.next_seq,
        }
    }

    /// Undoes the directories a failed `mkdir -p` made, newest first, so that
    /// nothing it did can be seen: each goes without an event, its parent's
    /// times go back to what they were before it was made, the log is cut back
    /// to where it was (with whether it had dropped any), and the inode
    /// numbers it used are given back. Allocates nothing. Only the clock,
    /// read by the removals, is not given back: a failed call may read it.
    fn undo_mkdirp(&mut self, made: &mut Vec<Made>, mark: Mark) {
        while let Some(undone) = made.pop() {
            // Its name is taken, not copied: the node is freed with it.
            let name = core::mem::take(&mut self.node_mut(undone.dir).name);
            self.remove_entry(undone.parent, &name, undone.dir, false);
            let parent = self.node_mut(undone.parent);
            parent.mtime = undone.mtime;
            parent.ctime = undone.ctime;
        }
        self.events.truncate(mark.events);
        self.events_dropped = mark.events_dropped;
        self.next_ino = mark.next_ino;
        self.next_seq = mark.next_seq;
    }

    // ---- node edits shared by paths and open files ----

    /// Opens `path` and returns the handle, with the node's count of handles
    /// raised (`file_closed` lowers it).
    ///
    /// Every check that needs no memory comes first, so that a call that
    /// would fail anyway names its own error and not ENOSPC. Then everything
    /// that can run short is had, before anything is made or truncated: for
    /// `open`, the handle's slot (keeping `HEADROOM` only when a file is
    /// made: reading must keep working); for a `writeFile`, the buffer for
    /// its bytes. So an open that fails for memory changes nothing.
    fn open_handle(
        &mut self,
        path: &[u8],
        flags: u32,
        mode: f64,
        opening: Opening,
    ) -> Result<Handle> {
        const OPEN: Syscall = Syscall::Open;
        let create = flags & O_CREAT != 0;
        let exclusive = create && flags & O_EXCL != 0;
        let no_follow = flags & O_NOFOLLOW != 0;
        let found = self.lookup(path, !no_follow && !exclusive, OPEN, PATH_FIRST)?;
        let accmode = flags & O_ACCMODE;
        // The checks: what the open will do, or its error.
        let target = match found.node {
            None => {
                if !create {
                    return fail(Errno::Enoent, OPEN, PATH_FIRST);
                }
                if flags & O_DIRECTORY != 0 {
                    return fail(Errno::Einval, OPEN, PATH_FIRST);
                }
                match found.parent {
                    Some(parent) if !found.dir_tail => Target::Create(parent),
                    _ => return fail(Errno::Eisdir, OPEN, PATH_FIRST),
                }
            }
            Some(node) => {
                if exclusive {
                    return fail(Errno::Eexist, OPEN, PATH_FIRST);
                }
                match &self.node(node).kind {
                    Kind::Symlink(_) => return fail(Errno::Eloop, OPEN, PATH_FIRST),
                    Kind::Dir(_) => {
                        if accmode != O_RDONLY || create || flags & O_TRUNC != 0 {
                            return fail(Errno::Eisdir, OPEN, PATH_FIRST);
                        }
                    }
                    Kind::File(_) => {
                        if flags & O_DIRECTORY != 0 {
                            return fail(Errno::Enotdir, OPEN, PATH_FIRST);
                        }
                    }
                }
                Target::Existing(node)
            }
        };
        // The memory, before anything changes.
        if opening == Opening::Handle && !self.reserve_handle(matches!(target, Target::Create(_))) {
            return fail(Errno::Enospc, OPEN, PATH_FIRST);
        }
        let node = match target {
            Target::Create(parent) => {
                // A write that will happen gets its buffer now (as `copy_file`
                // makes a copy), so that once the file is made nothing can
                // fail for memory. One that will not (a read-only handle, a
                // file too large) fails after the file is made, as in vfs.ts.
                let mut data = Vec::new();
                if let Opening::Write(length) = opening {
                    if length > 0 && accmode != O_RDONLY && length as f64 <= MAX_FILE_SIZE {
                        self.room(OPEN, PATH_FIRST)?;
                        reserve(&mut self.space, &mut data, length)
                            .map_err(|_| no_space(Syscall::Write, PATH_NONE))?;
                    }
                }
                let named = self.prepare(&found.name, OPEN, PATH_FIRST)?;
                let t = self.clock.now();
                let perm = creation_mode(mode, DEFAULT_FILE_MODE);
                let node = self.new_inode(perm, t, 1, Kind::File(FileData { data, size: 0 }));
                self.add_entry(parent, &found.name, named, node, t);
                node
            }
            Target::Existing(node) => {
                // O_TRUNC always truncates, as on Linux: even an empty file
                // gets new times and a change event (a "touch by empty write").
                let truncate =
                    flags & O_TRUNC != 0 && matches!(&self.node(node).kind, Kind::File(_));
                if truncate {
                    // The buffer grows as the write would grow it, only earlier.
                    if let Opening::Write(writing) = opening {
                        if accmode != O_RDONLY && writing > self.file(node).data.len() {
                            self.grow_data(node, writing)
                                .map_err(|_| no_space(Syscall::Write, PATH_NONE))?;
                        }
                    }
                    self.resize_data(node, 0)?;
                    self.emit_found(EVENT_CHANGE, &found);
                }
                node
            }
        };
        self.node_mut(node).handles += 1;
        Ok(Handle {
            node,
            flags,
            offset: 0.0,
        })
    }

    /// Makes sure `open` has a handle slot without allocating: a free one, or
    /// room for one more in the table and in its free list. Keeps `HEADROOM`
    /// after it only when `keep`.
    fn reserve_handle(&mut self, keep: bool) -> bool {
        if !self.free_handles.is_empty() {
            return true;
        }
        let slots = self.handles.len();
        grow_keeping(&mut self.space, &mut self.handles, 1, keep)
            && grow_keeping(&mut self.space, &mut self.free_handles, slots + 1, keep)
    }

    /// `VfsFile.write` up to the copy: returns where the bytes go.
    fn write_through(
        &mut self,
        handle: &mut Handle,
        length: usize,
        position: f64,
    ) -> Result<usize> {
        if handle.flags & O_ACCMODE == O_RDONLY || self.node(handle.node).is_dir() {
            return fail(Errno::Ebadf, Syscall::Write, PATH_NONE);
        }
        let at = if handle.flags & O_APPEND != 0 {
            self.file(handle.node).size as f64
        } else if position.is_nan() {
            handle.offset
        } else {
            position
        };
        let mut start = 0;
        if length > 0 {
            start = self.write_data(handle.node, length, at)?;
            self.emit_node(EVENT_CHANGE, handle.node);
        }
        if position.is_nan() {
            handle.offset = at + length as f64;
        }
        Ok(start)
    }

    /// `writeData` up to the copy: makes room for `length` bytes at `at` and
    /// returns where they go. Bytes in a gap before `at` are already zero.
    fn write_data(&mut self, node: Idx, length: usize, at: f64) -> Result<usize> {
        if at + length as f64 > MAX_FILE_SIZE {
            return fail(Errno::Efbig, Syscall::Write, PATH_NONE);
        }
        // vfs.ts never sees one (Node rejects it first); a typed array would
        // throw a RangeError.
        if at < 0.0 || !js::is_integer(at) {
            return fail(Errno::Einval, Syscall::Write, PATH_NONE);
        }
        let start = at as usize;
        let end = start
            .checked_add(length)
            .ok_or(no_space(Syscall::Write, PATH_NONE))?;
        if end > self.file(node).data.len() {
            self.grow_data(node, end)
                .map_err(|_| no_space(Syscall::Write, PATH_NONE))?;
        }
        let file = self.file_mut(node);
        let grown = end.saturating_sub(file.size);
        file.size = file.size.max(end);
        self.byte_count += grown as u64;
        let t = self.clock.now();
        let written = self.node_mut(node);
        written.mtime = t;
        written.ctime = t;
        Ok(start)
    }

    /// Sets a file's size. Shrinking allocates nothing and never fails.
    fn resize_data(&mut self, node: Idx, length: u64) -> Result<()> {
        let no_space = || no_space(Syscall::Ftruncate, PATH_NONE);
        let length = usize::try_from(length).map_err(|_| no_space())?;
        if length > self.file(node).data.len() {
            self.grow_data(node, length).map_err(|_| no_space())?;
        }
        let file = self.file_mut(node);
        let before = file.size;
        if length < before {
            file.data[length..before].fill(0);
        }
        file.size = length;
        self.byte_count = self.byte_count + length as u64 - before as u64;
        let t = self.clock.now();
        let resized = self.node_mut(node);
        resized.mtime = t;
        resized.ctime = t;
        Ok(())
    }

    /// `reserve` for a file's buffer.
    fn grow_data(&mut self, node: Idx, needed: usize) -> core::result::Result<(), ()> {
        let Some(Some(Inode {
            kind: Kind::File(file),
            ..
        })) = self.inodes.get_mut(node as usize)
        else {
            unreachable!("not a file");
        };
        reserve(&mut self.space, &mut file.data, needed)
    }

    fn set_mode(&mut self, node: Idx, mode: u32) {
        let t = self.clock.now();
        let changed = self.node_mut(node);
        changed.perm = mode & 0o7777;
        changed.ctime = t;
    }

    fn set_times(&mut self, node: Idx, atime: f64, mtime: f64) {
        let t = self.clock.now();
        let changed = self.node_mut(node);
        changed.atime = atime;
        changed.mtime = mtime;
        changed.ctime = t;
    }

    fn file_closed(&mut self, node: Idx) {
        let closed = self.node_mut(node);
        closed.handles -= 1;
        if closed.handles > 0 {
            return;
        }
        if closed.is_file() {
            if closed.nlink == 0 {
                self.release(node);
            }
        } else if closed.released {
            // A removed directory that was held open: only its slot was left.
            self.inodes[node as usize] = None;
            self.free_inodes.push(node);
        }
    }

    fn handle(&self, number: u32, syscall: Syscall) -> Result<Handle> {
        match self.handles.get(number as usize) {
            Some(Some(handle)) => Ok(*handle),
            _ => fail(Errno::Ebadf, syscall, PATH_NONE),
        }
    }

    // ---- notification ----

    /// Logs `event` for the entry `name` in `parent`, writing its path
    /// straight into the log. The path is measured first, by one walk that
    /// allocates nothing and stops as soon as the event cannot fit: an event
    /// the log has no room for (`EVENT_LOG_LIMIT`, or memory) is dropped, and
    /// said so, before anything is built. Nothing is logged when `parent` is
    /// detached.
    ///
    /// Once an event is lost, nothing more is logged until the log is drained
    /// (`clear_events`): the watchers are then told that something changed,
    /// which covers every later event too. So a log that is full costs the
    /// rest of a large removal nothing.
    fn log_entry(&mut self, event: u8, parent: Idx, name: &[u8]) {
        if self.events_dropped {
            return;
        }
        let Some(room) = EVENT_LOG_LIMIT.checked_sub(self.events.len() + 5) else {
            self.events_dropped = true;
            return;
        };
        let length = match self.entry_path_len(parent, name, room) {
            PathLength::Detached => return,
            PathLength::Over => {
                self.events_dropped = true;
                return;
            }
            PathLength::Fits(length) => length,
        };
        let size = 5 + length;
        // Growing the log keeps the headroom: events never take what the
        // tree needs.
        if !grow(&mut self.space, &mut self.events, size) {
            self.events_dropped = true;
            return;
        }
        let mut events = core::mem::take(&mut self.events);
        let start = events.len();
        events.push(event);
        events.extend_from_slice(&(length as u32).to_le_bytes());
        // Within the room just made: allocates nothing.
        let written = self.entry_path_into(parent, name, &mut events);
        if !matches!(written, Ok(true)) || events.len() != start + size {
            unreachable!("an event path measured as attached is written as measured");
        }
        self.events = events;
    }

    fn log_event(&mut self, event: u8, path: &[u8]) {
        if self.events_dropped {
            return;
        }
        let size = 5 + path.len();
        // Growing the log keeps the headroom: events never take what the
        // tree needs. An event that does not fit is dropped and said so.
        if self.events.len() + size > EVENT_LOG_LIMIT
            || !grow(&mut self.space, &mut self.events, size)
        {
            self.events_dropped = true;
            return;
        }
        self.events.push(event);
        self.events
            .extend_from_slice(&(path.len() as u32).to_le_bytes());
        self.events.extend_from_slice(path);
    }

    fn emit_entry(&mut self, event: u8, parent: Idx, name: &[u8]) {
        if self.watching {
            self.log_entry(event, parent, name);
        }
    }

    /// The path of the entry `name` in `parent` for an event logged later:
    /// `Ok(None)` when `parent` is detached, `Err` when it will be dropped
    /// (no room in the log, or no memory for the path). Changes nothing:
    /// dropping is said (`events_dropped`) only when the event is logged,
    /// so that a call that fails after this leaves no trace.
    fn event_path(&self, parent: Idx, name: &[u8]) -> core::result::Result<Option<Vec<u8>>, ()> {
        if self.events_dropped {
            return Err(());
        }
        let room = EVENT_LOG_LIMIT
            .checked_sub(self.events.len() + 5)
            .ok_or(())?;
        match self.entry_path_len(parent, name, room) {
            PathLength::Detached => return Ok(None),
            PathLength::Over => return Err(()),
            PathLength::Fits(_) => {}
        }
        self.entry_path(parent, name).map_err(|NoMemory| ())
    }

    fn emit_found(&mut self, event: u8, found: &Lookup) {
        if let Some(parent) = found.parent {
            self.emit_entry(event, parent, &found.name);
        } else if let Some(node) = found.node {
            self.emit_node(event, node);
        }
    }

    /// Reports a change to `node` at its primary link, if it still has one.
    fn emit_node(&mut self, event: u8, node: Idx) {
        if !self.watching {
            return;
        }
        if node == self.root {
            self.log_event(event, b"/");
            return;
        }
        let Some(parent) = self.node(node).parent else {
            return;
        };
        // Lent, not copied: `parent` is not below `node`, so the walk to the
        // root does not read it.
        let name = core::mem::take(&mut self.node_mut(node).name);
        self.log_entry(event, parent, &name);
        self.node_mut(node).name = name;
    }

    // ---- paths of nodes ----

    /// True when `dir` is `ancestor` or lies below it.
    fn is_within(&self, dir: Idx, ancestor: Idx) -> bool {
        let mut current = Some(dir);
        while let Some(at) = current {
            if at == ancestor {
                return true;
            }
            let parent = self.node(at).parent;
            if parent == Some(at) {
                return false;
            }
            current = parent;
        }
        false
    }

    /// The length of the path of the entry `name` in `parent`, measured by
    /// one walk to the root that allocates nothing and stops once it passes
    /// `limit` (so its cost is bounded by `limit` too).
    fn entry_path_len(&self, parent: Idx, name: &[u8], limit: usize) -> PathLength {
        // Each level adds a slash and its name: the root's entries are `/name`.
        let mut length = 1 + name.len();
        let mut current = parent;
        loop {
            if length > limit {
                return PathLength::Over;
            }
            let at = self.node(current);
            match at.parent {
                None => return PathLength::Detached,
                Some(up) if up == current => return PathLength::Fits(length),
                Some(up) => {
                    length += 1 + at.name.len();
                    current = up;
                }
            }
        }
    }

    /// Appends the absolute path of a directory to `out`; false when it is no
    /// longer in the tree. A path has no bound (names of 64 KiB, nested), so
    /// its room is asked for: it is measured walking up, then written from
    /// its end walking up again.
    fn dir_path(&self, dir: Idx, out: &mut Vec<u8>) -> core::result::Result<bool, NoMemory> {
        let mut length = 0;
        let mut current = dir;
        loop {
            let at = self.node(current);
            match at.parent {
                None => return Ok(false),
                Some(parent) if parent == current => break,
                Some(parent) => {
                    length += 1 + at.name.len();
                    current = parent;
                }
            }
        }
        let start = out.len();
        let length = length.max(1);
        out.try_reserve(length).map_err(|_| NoMemory)?;
        out.resize(start + length, SLASH);
        let mut end = start + length;
        let mut current = dir;
        while current != self.root {
            let at = self.node(current);
            out[end - at.name.len()..end].copy_from_slice(&at.name);
            end -= at.name.len() + 1;
            current = match at.parent {
                Some(parent) => parent,
                None => unreachable!("measured as attached"),
            };
        }
        Ok(true)
    }

    /// Appends the absolute path of the entry `name` in `parent` to `out`;
    /// false when `parent` is detached.
    fn entry_path_into(
        &self,
        parent: Idx,
        name: &[u8],
        out: &mut Vec<u8>,
    ) -> core::result::Result<bool, NoMemory> {
        let start = out.len();
        if !self.dir_path(parent, out)? {
            return Ok(false);
        }
        let slash = usize::from(out.len() - start > 1);
        out.try_reserve(slash + name.len()).map_err(|_| NoMemory)?;
        if slash == 1 {
            out.push(SLASH);
        }
        out.extend_from_slice(name);
        Ok(true)
    }

    fn entry_path(
        &self,
        parent: Idx,
        name: &[u8],
    ) -> core::result::Result<Option<Vec<u8>>, NoMemory> {
        let mut path = Vec::new();
        Ok(self
            .entry_path_into(parent, name, &mut path)?
            .then_some(path))
    }

    // ---- access to nodes ----

    fn node(&self, node: Idx) -> &Inode {
        match &self.inodes[node as usize] {
            Some(inode) => inode,
            None => unreachable!("a freed inode is referenced"),
        }
    }

    fn node_mut(&mut self, node: Idx) -> &mut Inode {
        match &mut self.inodes[node as usize] {
            Some(inode) => inode,
            None => unreachable!("a freed inode is referenced"),
        }
    }

    fn entries(&self, dir: Idx) -> &BTreeMap<Box<[u8]>, Entry> {
        match &self.node(dir).kind {
            Kind::Dir(entries) => entries,
            _ => unreachable!("not a directory"),
        }
    }

    fn entries_mut(&mut self, dir: Idx) -> &mut BTreeMap<Box<[u8]>, Entry> {
        match &mut self.node_mut(dir).kind {
            Kind::Dir(entries) => entries,
            _ => unreachable!("not a directory"),
        }
    }

    fn file(&self, node: Idx) -> &FileData {
        match &self.node(node).kind {
            Kind::File(file) => file,
            _ => unreachable!("not a file"),
        }
    }

    fn file_mut(&mut self, node: Idx) -> &mut FileData {
        match &mut self.node_mut(node).kind {
            Kind::File(file) => file,
            _ => unreachable!("not a file"),
        }
    }

    fn file_bytes_mut(&mut self, node: Idx, start: usize, length: usize) -> &mut [u8] {
        if length == 0 {
            return &mut [];
        }
        &mut self.file_mut(node).data[start..start + length]
    }

    /// Copies the first `length` bytes of file `from` over those of file `to`.
    fn copy_bytes(&mut self, from: Idx, to: Idx, length: usize) {
        let (low, high) = (from.min(to) as usize, from.max(to) as usize);
        let (head, tail) = self.inodes.split_at_mut(high);
        let (low, high) = (head[low].as_mut(), tail[0].as_mut());
        let (Some(low), Some(high)) = (low, high) else {
            unreachable!("a freed inode is referenced");
        };
        let (source, target) = if from < to { (low, high) } else { (high, low) };
        let (Kind::File(source), Kind::File(target)) = (&source.kind, &mut target.kind) else {
            unreachable!("not a file");
        };
        target.data[..length].copy_from_slice(&source.data[..length]);
    }

    fn touch(&mut self, dir: Idx, t: f64) {
        let touched = self.node_mut(dir);
        touched.mtime = t;
        touched.ctime = t;
    }

    fn stat_of(&self, node: Idx) -> Stat {
        let inode = self.node(node);
        let (kind, size) = match &inode.kind {
            Kind::File(file) => (S_IFREG, file.size),
            Kind::Dir(_) => (S_IFDIR, DIR_SIZE),
            Kind::Symlink(target) => (S_IFLNK, target.len()),
        };
        [
            DEV,
            inode.ino as f64,
            (kind | inode.perm) as f64,
            inode.nlink as f64,
            UID,
            GID,
            0.0,
            size as f64,
            BLKSIZE,
            size.div_ceil(512) as f64,
            inode.atime,
            inode.mtime,
            inode.ctime,
            inode.birthtime,
        ]
    }

    // ---- consistency (tests) ----

    /// Whether the tree's invariants hold (`try_check`).
    pub fn check(&self) -> bool {
        self.try_check() == Some(true)
    }

    /// Whether the tree's invariants hold: every entry names a live inode,
    /// link counts match the entries, a directory's parent and name match its
    /// entry, primary links exist, the totals match a recount, handles and
    /// free lists name the right slots and have the room that lets freeing
    /// allocate nothing, file bytes past the size are zero and the event log
    /// is well formed. None when there is not the memory to look: it is asked
    /// for, so that checking a full filesystem cannot abort.
    pub fn try_check(&self) -> Option<bool> {
        let slots = self.inodes.len();
        if self.free_inodes.capacity() < slots.saturating_sub(1)
            || self.free_handles.capacity() < self.handles.len()
        {
            return Some(false);
        }
        let mut entries_naming = filled(slots, 0u32)?;
        let mut subdirs = filled(slots, 0u32)?;
        match self.inodes.get(self.root as usize) {
            Some(Some(root))
                if root.is_dir() && !root.released && root.parent == Some(self.root) => {}
            _ => return Some(false),
        }
        let mut pending = filled(1, self.root)?;
        while let Some(dir) = pending.pop() {
            for (name, entry) in self.entries(dir) {
                let Some(Some(child)) = self.inodes.get(entry.node as usize) else {
                    return Some(false);
                };
                if child.released || entry.seq >= self.next_seq || name.is_empty() {
                    return Some(false);
                }
                entries_naming[entry.node as usize] += 1;
                if child.is_dir() {
                    if entries_naming[entry.node as usize] > 1
                        || child.parent != Some(dir)
                        || *child.name != **name
                    {
                        return Some(false);
                    }
                    subdirs[dir as usize] += 1;
                    pending.try_reserve(1).ok()?;
                    pending.push(entry.node);
                }
            }
        }

        let mut handles_on = filled(slots, 0u32)?;
        for handle in self.handles.iter().flatten() {
            match self.inodes.get(handle.node as usize) {
                Some(Some(_)) => handles_on[handle.node as usize] += 1,
                _ => return Some(false),
            }
        }
        let mut free_handle = filled(self.handles.len(), false)?;
        for &number in &self.free_handles {
            match self.handles.get(number as usize) {
                Some(None) if !free_handle[number as usize] => free_handle[number as usize] = true,
                _ => return Some(false),
            }
        }
        if free_handle.iter().filter(|&&free| free).count()
            != self
                .handles
                .iter()
                .filter(|handle| handle.is_none())
                .count()
        {
            return Some(false);
        }
        let mut free_slot = filled(slots, false)?;
        for &slot in &self.free_inodes {
            match self.inodes.get(slot as usize) {
                Some(None) if !free_slot[slot as usize] => free_slot[slot as usize] = true,
                _ => return Some(false),
            }
        }
        if free_slot.iter().filter(|&&free| free).count()
            != self.inodes.iter().filter(|slot| slot.is_none()).count()
        {
            return Some(false);
        }

        let mut inodes = 0;
        let mut bytes = 0;
        let mut inos = Vec::new();
        inos.try_reserve_exact(slots).ok()?;
        for (slot, inode) in self.inodes.iter().enumerate() {
            let Some(inode) = inode else {
                continue;
            };
            let named = entries_naming[slot];
            if inode.handles != handles_on[slot] || inode.ino == 0 || inode.ino >= self.next_ino {
                return Some(false);
            }
            inos.push(inode.ino);
            if inode.released {
                if !inode.is_dir() || inode.handles == 0 || named != 0 || inode.parent.is_some() {
                    return Some(false);
                }
                continue;
            }
            inodes += 1;
            let sound = match &inode.kind {
                Kind::Dir(_) => {
                    inode.nlink == 2 + subdirs[slot] && (named == 1 || slot == self.root as usize)
                }
                Kind::File(file) => {
                    bytes += file.size as u64;
                    inode.nlink == named
                        && (named > 0 || inode.handles > 0)
                        && file.size <= file.data.len()
                        && file.data[file.size..].iter().all(|&byte| byte == 0)
                }
                Kind::Symlink(_) => inode.nlink == named && named > 0 && inode.handles == 0,
            };
            if !sound {
                return Some(false);
            }
            if slot != self.root as usize {
                if let Some(parent) = inode.parent {
                    let primary = match self.inodes.get(parent as usize) {
                        Some(Some(Inode {
                            kind: Kind::Dir(entries),
                            released: false,
                            ..
                        })) => entries.get(&inode.name[..]).map(|entry| entry.node),
                        _ => None,
                    };
                    if primary != Some(slot as Idx) {
                        return Some(false);
                    }
                } else if inode.is_dir() {
                    return Some(false);
                }
            }
        }
        inos.sort_unstable();
        if inos.windows(2).any(|pair| pair[0] == pair[1]) {
            return Some(false);
        }

        let mut at = 0;
        while at < self.events.len() {
            if at + 5 > self.events.len() || self.events[at] > EVENT_CHANGE {
                return Some(false);
            }
            let mut length = [0u8; 4];
            length.copy_from_slice(&self.events[at + 1..at + 5]);
            at += 5 + u32::from_le_bytes(length) as usize;
        }
        Some(at == self.events.len() && inodes == self.inode_count && bytes == self.byte_count)
    }
}

/// `length` copies of `value`, or None when there is not the memory.
fn filled<T: Clone>(length: usize, value: T) -> Option<Vec<T>> {
    let mut vec = Vec::new();
    vec.try_reserve_exact(length).ok()?;
    vec.resize(length, value);
    Some(vec)
}

/// The error mkdir -p raises for a non-directory: EEXIST at the path asked
/// for, ENOTDIR at one of its parents.
fn not_a_dir(at_requested: bool) -> Errno {
    if at_requested {
        Errno::Eexist
    } else {
        Errno::Enotdir
    }
}

fn no_space(syscall: Syscall, path_mode: u32) -> Failure {
    Failure {
        errno: Errno::Enospc,
        syscall,
        path_mode,
    }
}

/// `readBytes` of inode.ts: nothing when `at >= size` or `length <= 0`, else
/// `data.slice(at, Math.min(size, at + length))`, with the slice's reading of
/// its indexes (`slice_index`). `data` is the whole buffer, `capacity` bytes:
/// a negative index counts from its end, not from the end of the file.
fn read_range(size: usize, capacity: usize, length: f64, at: f64) -> (usize, usize) {
    let total = size as f64;
    if at >= total || length <= 0.0 {
        return (0, 0);
    }
    let sum = at + length;
    // `Math.min` gives NaN when either side is NaN.
    let end = if sum.is_nan() || sum < total {
        sum
    } else {
        total
    };
    let capacity = capacity as f64;
    let (start, end) = (slice_index(at, capacity), slice_index(end, capacity));
    if end > start {
        (start, end)
    } else {
        (0, 0)
    }
}

/// How `TypedArray.prototype.slice` reads an index into `size` bytes:
/// truncated, NaN as 0, a negative one counted from the end, then clamped.
fn slice_index(index: f64, size: f64) -> usize {
    let index = js::trunc(index);
    let at = if index.is_nan() {
        0.0
    } else if index < 0.0 {
        (size + index).max(0.0)
    } else {
        index.min(size)
    };
    at as usize
}
