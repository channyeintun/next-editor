//! Running out of memory: every operation that adds to the tree fails with
//! ENOSPC and changes nothing, wherever in it the memory runs out; removing,
//! truncating to less, closing and reading go on working with none at all.
//!
//! The system allocator never runs short, so a budget stands in for the
//! allocator's answer (`Space`): it says yes a given number of times, then no.
//! Every growth of a buffer or a table asks it after growing, and gives the
//! memory back on a no, so a budget reaches each of those points too.
use super::*;
use crate::abi::{Errno::*, Syscall};
use crate::counting;
use std::cell::Cell;
use std::rc::Rc;
use std::string::String;

const WRITE: u32 = O_WRONLY | O_CREAT | O_TRUNC;

struct Steady;

impl Clock for Steady {
    fn now(&mut self) -> f64 {
        1000.0
    }
}

/// How many more times the space says yes (None for always), and whether it
/// says no to anything but `HEADROOM`.
#[derive(Clone, Default)]
struct Budget {
    left: Rc<Cell<Option<u32>>>,
    headroom_only: Rc<Cell<bool>>,
}

impl Budget {
    fn allow(&self, times: Option<u32>) {
        self.left.set(times);
    }
}

impl Space for Budget {
    fn can_allocate(&mut self, bytes: usize) -> bool {
        if self.headroom_only.get() && bytes != HEADROOM {
            return false;
        }
        match self.left.get() {
            None => true,
            Some(0) => false,
            Some(left) => {
                self.left.set(Some(left - 1));
                true
            }
        }
    }
}

type BudgetFs = Fs<Steady, Budget>;

fn setup() -> (BudgetFs, Budget) {
    let budget = Budget::default();
    (Fs::with_space(Steady, budget.clone()), budget)
}

fn put(fs: &mut BudgetFs, path: &str, content: &[u8], flags: u32) -> Result<()> {
    fs.write_file(path.as_bytes(), flags, 0o644 as f64, content.len())
        .map(|room| room.copy_from_slice(content))
}

fn failure<T: core::fmt::Debug>(result: Result<T>) -> (Errno, Syscall, u32) {
    let failure = result.unwrap_err();
    (failure.errno, failure.syscall, failure.path_mode)
}

/// Everything an operation could change: the tree, file by file, and the totals.
fn snapshot(fs: &mut BudgetFs) -> (Vec<String>, (u64, u64)) {
    let mut lines = Vec::new();
    let mut pending = vec![String::from("/")];
    while let Some(dir) = pending.pop() {
        let (listing, _) = fs.readdir(dir.as_bytes()).unwrap();
        let listing = listing.to_vec();
        let mut at = 0;
        while at < listing.len() {
            let kind = listing[at];
            let length = u32::from_le_bytes(listing[at + 1..at + 5].try_into().unwrap()) as usize;
            let name = String::from_utf8(listing[at + 5..at + 5 + length].to_vec()).unwrap();
            at += 5 + length;
            let path = if dir == "/" {
                format!("/{name}")
            } else {
                format!("{dir}/{name}")
            };
            let stat = fs.stat(path.as_bytes(), false).unwrap();
            let mut line = format!("{path} {kind} {:?}", &stat[..10]);
            match kind {
                KIND_DIR => pending.push(path),
                KIND_FILE => line += &format!(" {:?}", fs.read_file(path.as_bytes()).unwrap()),
                _ => line += &format!(" -> {:?}", fs.readlink(path.as_bytes()).unwrap()),
            }
            lines.push(line);
        }
    }
    lines.sort();
    (lines, fs.totals())
}

/// A small tree: a directory with a file, a hard link, a symbolic link, and
/// an open file.
fn populated() -> (BudgetFs, Budget, u32) {
    let (mut fs, budget) = setup();
    fs.mkdir(b"/d", false, f64::NAN).unwrap();
    put(&mut fs, "/d/f", b"abc", WRITE).unwrap();
    put(&mut fs, "/big", &[7u8; 1000], WRITE).unwrap();
    fs.link(b"/d/f", b"/hard").unwrap();
    fs.symlink(b"/d", b"/l").unwrap();
    let handle = fs.open(b"/d/f", O_RDWR, f64::NAN).unwrap();
    assert!(fs.check());
    (fs, budget, handle)
}

/// Each operation that adds, run with no memory at all: its ENOSPC, naming
/// what its other errors name.
type Adding = (
    &'static str,
    fn(&mut BudgetFs, u32) -> Result<()>,
    (Errno, Syscall, u32),
);

const ADDING: &[Adding] = &[
    (
        "mkdir",
        |fs, _| fs.mkdir(b"/n", false, f64::NAN).map(drop),
        (Enospc, Syscall::Mkdir, PATH_FIRST),
    ),
    (
        "mkdir -p",
        |fs, _| fs.mkdir(b"/n/a/b", true, f64::NAN).map(drop),
        (Enospc, Syscall::Mkdir, PATH_FIRST),
    ),
    (
        "mkdir -p in a link",
        |fs, _| fs.mkdir(b"/l/a/b", true, f64::NAN).map(drop),
        (Enospc, Syscall::Mkdir, PATH_FIRST),
    ),
    (
        "mkdtemp",
        |fs, _| fs.mkdtemp(b"/tmpabcdef").map(drop),
        (Enospc, Syscall::Mkdtemp, PATH_FIRST),
    ),
    (
        "a new empty file",
        |fs, _| put(fs, "/new", b"", WRITE),
        (Enospc, Syscall::Open, PATH_FIRST),
    ),
    (
        "a new file",
        |fs, _| put(fs, "/new", b"data", WRITE),
        (Enospc, Syscall::Open, PATH_FIRST),
    ),
    (
        "a longer overwrite",
        |fs, _| put(fs, "/d/f", &[1; 10], WRITE),
        (Enospc, Syscall::Write, PATH_NONE),
    ),
    (
        "an append",
        |fs, _| put(fs, "/d/f", b"defgh", O_WRONLY | O_APPEND),
        (Enospc, Syscall::Write, PATH_NONE),
    ),
    (
        "open to create",
        |fs, _| fs.open(b"/new", O_RDWR | O_CREAT, f64::NAN).map(drop),
        (Enospc, Syscall::Open, PATH_FIRST),
    ),
    (
        "symlink",
        |fs, _| fs.symlink(b"/d/f", b"/s"),
        (Enospc, Syscall::Symlink, PATH_BOTH),
    ),
    (
        "link",
        |fs, _| fs.link(b"/d/f", b"/d/g"),
        (Enospc, Syscall::Link, PATH_BOTH),
    ),
    (
        "rename",
        |fs, _| fs.rename(b"/d/f", b"/d/g"),
        (Enospc, Syscall::Rename, PATH_BOTH),
    ),
    (
        "rename over a file",
        |fs, _| fs.rename(b"/big", b"/hard"),
        (Enospc, Syscall::Rename, PATH_BOTH),
    ),
    (
        "copyFile",
        |fs, _| fs.copy_file(b"/big", b"/copy", 0),
        (Enospc, Syscall::Copyfile, PATH_BOTH),
    ),
    (
        "copyFile over a file",
        |fs, _| fs.copy_file(b"/big", b"/d/f", 0),
        (Enospc, Syscall::Copyfile, PATH_BOTH),
    ),
    (
        "truncate to more",
        |fs, _| fs.truncate(b"/d/f", 100.0),
        (Enospc, Syscall::Ftruncate, PATH_NONE),
    ),
    (
        "ftruncate to more",
        |fs, h| fs.handle_truncate(h, 100.0),
        (Enospc, Syscall::Ftruncate, PATH_NONE),
    ),
    (
        "write past the buffer",
        |fs, h| fs.handle_write(h, 10, 0.0).map(drop),
        (Enospc, Syscall::Write, PATH_NONE),
    ),
];

#[test]
fn every_operation_that_adds_fails_with_enospc_and_changes_nothing() {
    for &(name, operation, expected) in ADDING {
        let (mut fs, budget, handle) = populated();
        fs.watching = true;
        let before = snapshot(&mut fs);
        fs.clear_events();
        budget.allow(Some(0));
        assert_eq!(failure(operation(&mut fs, handle)), expected, "{name}");
        budget.allow(None);
        assert!(fs.check(), "{name}");
        assert_eq!(snapshot(&mut fs), before, "{name}");
        // Nothing happened, so nothing is reported.
        assert!(fs.events().is_empty() && !fs.events_dropped(), "{name}");
        // With memory again it works.
        operation(&mut fs, handle).unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert!(fs.check(), "{name}");
    }
}

#[test]
fn runs_out_at_any_point_of_an_operation_and_still_changes_nothing() {
    for &(name, operation, (_, syscall, path_mode)) in ADDING {
        let mut succeeded = false;
        for allowed in 0..40 {
            let (mut fs, budget, handle) = populated();
            fs.watching = true;
            let before = snapshot(&mut fs);
            budget.allow(Some(allowed));
            let result = operation(&mut fs, handle);
            budget.allow(None);
            assert!(fs.check(), "{name} with {allowed}");
            match result {
                Ok(()) => {
                    succeeded = true;
                    break;
                }
                Err(failure) => {
                    assert_eq!(failure.errno, Enospc, "{name} with {allowed}");
                    // A write that fails in its data still names the write.
                    if failure.syscall != Syscall::Write {
                        assert_eq!(
                            (failure.syscall, failure.path_mode),
                            (syscall, path_mode),
                            "{name} with {allowed}"
                        );
                    }
                    assert_eq!(snapshot(&mut fs), before, "{name} with {allowed}");
                }
            }
        }
        assert!(succeeded, "{name} never succeeded");
    }
}

#[test]
fn undoes_the_directories_mkdir_p_made_before_it_ran_out() {
    let mut undone = 0;
    for allowed in 0..200 {
        let (mut fs, budget) = setup();
        fs.mkdir(b"/x", false, f64::NAN).unwrap();
        fs.watching = true;
        let before = snapshot(&mut fs);
        fs.clear_events();
        let (next_ino, free_slots) = (fs.next_ino, fs.free_inodes.len());
        budget.allow(Some(allowed));
        // Climbs out of what it made with `..`: what it makes is not all below one directory.
        let result = fs
            .mkdir(b"/x/a/b/../../y/c/d/e", true, f64::NAN)
            .map(|first| first.map(<[u8]>::to_vec));
        budget.allow(None);
        assert!(fs.check());
        match result {
            Ok(first) => {
                assert_eq!(first.as_deref(), Some(&b"/x/a"[..]));
                assert!(fs.exists(b"/x/y/c/d/e") && fs.exists(b"/x/a/b"));
                assert!(undone > 0, "never ran out midway");
                return;
            }
            Err(failure) => {
                assert_eq!(
                    (failure.errno, failure.syscall, failure.path_mode),
                    (Enospc, Syscall::Mkdir, PATH_FIRST)
                );
                assert_eq!(snapshot(&mut fs), before);
                // Undone without a trace: no event for what was made and
                // removed, and the inode numbers given back.
                assert!(fs.events().is_empty() && !fs.events_dropped());
                assert_eq!(fs.next_ino, next_ino);
                // The slots of what was made and undone are free again.
                if fs.free_inodes.len() > free_slots {
                    undone += 1;
                }
            }
        }
    }
    panic!("mkdir -p never succeeded");
}

#[test]
fn removes_closes_truncates_and_reads_with_no_memory_at_all() {
    let (mut fs, budget, handle) = populated();
    fs.mkdir(b"/t/a/b", true, f64::NAN).unwrap();
    for i in 0..50 {
        put(&mut fs, &format!("/t/a/f{i}"), b"x", WRITE).unwrap();
        put(&mut fs, &format!("/t/a/b/g{i}"), b"y", WRITE).unwrap();
    }
    fs.link(b"/t/a/f3", b"/t/a/b/linked").unwrap();
    fs.watching = true;
    budget.allow(Some(0));

    assert_eq!(fs.read_file(b"/l/f").unwrap(), b"abc");
    assert_eq!(fs.stat(b"/hard", true).unwrap()[3], 2.0);
    assert!(fs.exists(b"/t/a/b/g7"));
    assert_eq!(fs.readdir(b"/t/a").unwrap().1, 51);
    assert_eq!(fs.realpath(b"/l/f").unwrap(), b"/d/f");
    assert_eq!(fs.readlink(b"/l").unwrap(), b"/d");
    assert_eq!(fs.handle_read(handle, 3.0, 0.0).unwrap(), b"abc");
    fs.access(b"/d/f", 0).unwrap();
    // A write inside the buffer needs nothing.
    fs.handle_write(handle, 3, 0.0)
        .unwrap()
        .copy_from_slice(b"xyz");
    fs.chmod(b"/d/f", 0o600, true).unwrap();
    fs.utimes(b"/d/f", Some(1.0), Some(2.0), true).unwrap();
    // Their events had no room: dropped, and said so.
    assert!(fs.events_dropped());

    fs.truncate(b"/big", 10.0).unwrap();
    fs.handle_truncate(handle, 1.0).unwrap();
    fs.handle_close(handle).unwrap();
    fs.unlink(b"/hard").unwrap();
    fs.rm(b"/t", true, false).unwrap();
    fs.rmdir(b"/n").unwrap_err();
    fs.rm(b"/d", true, false).unwrap();
    fs.unlink(b"/l").unwrap();
    // An open on an existing file needs only its handle's slot, freed above.
    let again = fs.open(b"/big", O_RDONLY, f64::NAN).unwrap();
    fs.handle_close(again).unwrap();
    assert!(fs.check());
    assert_eq!(fs.totals(), (2, 10));
}

#[test]
fn removes_a_tree_with_the_same_events_with_no_memory_for_its_levels() {
    let order = |memory_for_levels: bool| {
        let (mut fs, budget) = setup();
        fs.mkdir(b"/d/a", true, f64::NAN).unwrap();
        put(&mut fs, "/d/z", b"", WRITE).unwrap();
        put(&mut fs, "/d/a/f", b"", WRITE).unwrap();
        fs.mkdir(b"/d/a/c", false, f64::NAN).unwrap();
        put(&mut fs, "/d/b", b"", WRITE).unwrap();
        put(&mut fs, "/d/y", b"", WRITE).unwrap();
        fs.rename(b"/d/y", b"/d/w").unwrap();
        fs.link(b"/d/b", b"/d/v").unwrap();
        fs.link(b"/d/a/f", b"/d/a/c/e").unwrap();
        fs.watching = true;
        // The log may grow; the sorted levels get nothing.
        budget.headroom_only.set(!memory_for_levels);
        fs.rm(b"/d", true, false).unwrap();
        budget.headroom_only.set(false);
        assert!(fs.check());
        assert_eq!(fs.totals(), (1, 0));
        assert!(!fs.events_dropped());
        event_paths(fs.events())
    };
    let sorted = order(true);
    // With memory: the order vfs.ts removes in, each directory's entries in
    // the order they were made.
    assert_eq!(
        sorted,
        ["/d/a/f", "/d/a/c/e", "/d/a/c", "/d/a", "/d/z", "/d/b", "/d/w", "/d/v", "/d"]
    );
    // Without: each directory's entries in the order of their names, so the
    // same events in another order, a directory's still after its contents'.
    let unsorted = order(false);
    assert_eq!(
        unsorted,
        ["/d/a/c/e", "/d/a/c", "/d/a/f", "/d/a", "/d/b", "/d/v", "/d/w", "/d/z", "/d"]
    );
    let set = |paths: &[String]| {
        let mut paths = paths.to_vec();
        paths.sort();
        paths
    };
    assert_eq!(set(&unsorted), set(&sorted));
    for events in [&sorted, &unsorted] {
        assert_contents_first(events);
    }
}

/// The paths of a log's events, oldest first.
fn event_paths(events: &[u8]) -> Vec<String> {
    let mut paths = Vec::new();
    let mut at = 0;
    while at < events.len() {
        let length = u32::from_le_bytes(events[at + 1..at + 5].try_into().unwrap()) as usize;
        paths.push(String::from_utf8(events[at + 5..at + 5 + length].to_vec()).unwrap());
        at += 5 + length;
    }
    paths
}

/// Each removal's event comes after every event of what was below it.
fn assert_contents_first(paths: &[String]) {
    for (at, path) in paths.iter().enumerate() {
        let below = format!("{path}/");
        assert!(
            !paths[at + 1..]
                .iter()
                .any(|later| later.starts_with(&below)),
            "{path} before its contents in {paths:?}"
        );
    }
}

#[test]
fn a_full_log_drops_events_but_keeps_the_operation() {
    let (mut fs, budget) = setup();
    // A free inode slot, and a log that has never held anything.
    put(&mut fs, "/a", b"1", WRITE).unwrap();
    fs.unlink(b"/a").unwrap();
    fs.watching = true;
    // The operation's own check passes; the log's growth after it does not.
    budget.allow(Some(1));
    fs.mkdir(b"/d", false, f64::NAN).unwrap();
    budget.allow(None);
    assert!(fs.exists(b"/d"));
    assert!(fs.events().is_empty() && fs.events_dropped());
    assert!(fs.check());
}

/// A heap of a size set later, with no fragmentation: what this thread holds
/// and the bytes asked for must fit in it.
struct Sized {
    limit: Rc<Cell<usize>>,
}

impl Space for Sized {
    fn can_allocate(&mut self, bytes: usize) -> bool {
        counting::live().saturating_add(bytes) <= self.limit.get()
    }
}

#[test]
fn a_table_that_cannot_double_grows_by_what_is_needed() {
    let limit = Rc::new(Cell::new(usize::MAX));
    let space = Sized {
        limit: limit.clone(),
    };
    let mut fs = Fs::with_space(Steady, space);
    // Fill the inode table to exactly its capacity, with no free slot.
    let mut made = 0;
    while made < 4000 || fs.inodes.len() < fs.inodes.capacity() {
        let path = std::format!("/f{made}");
        fs.write_file(path.as_bytes(), WRITE, 420.0, 0).unwrap();
        made += 1;
    }
    assert!(fs.free_inodes.is_empty());
    let slot = size_of::<Option<Inode>>();
    // Room for the headroom, one more slot and the new file's names and
    // entry, but nowhere near the table doubled.
    let slack = 64 * 1024;
    assert!(fs.inodes.capacity() * slot > 2 * slack);
    limit.set(counting::live() + HEADROOM + slot + slack);
    fs.write_file(b"/one-more", WRITE, 420.0, 0).unwrap();
    limit.set(usize::MAX);
    assert!(fs.check());
}
