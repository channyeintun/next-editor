//! The permission rules (README.md of webnode, "permissions"): what Linux
//! checks for a user who is not root and owns every file but those given to
//! root, so the owner's bits decide, or the others' on root's. The same cases run on `kernel/vfs/vfs.ts` in `vfs.test.ts`; the
//! differential test compares both on random trees with random modes.
use super::*;
use crate::abi::{Errno::*, Syscall};
use std::string::String;

const WRITE: u32 = O_WRONLY | O_CREAT | O_TRUNC;
const MODE: usize = 2;

struct TestClock(f64);

impl Clock for TestClock {
    fn now(&mut self) -> f64 {
        self.0 += 1.0;
        self.0
    }
}

type TestFs = Fs<TestClock>;

fn setup() -> TestFs {
    Fs::new(TestClock(1000.0))
}

fn put(fs: &mut TestFs, path: &str, content: &str) {
    fs.write_file(path.as_bytes(), WRITE, 0o644 as f64, content.len())
        .unwrap()
        .copy_from_slice(content.as_bytes());
    assert!(fs.check());
}

fn mkdir(fs: &mut TestFs, path: &str) {
    fs.mkdir(path.as_bytes(), false, 0o755 as f64).unwrap();
}

fn chmod(fs: &mut TestFs, path: &str, mode: u32) {
    fs.chmod(path.as_bytes(), mode, true).unwrap();
}

fn mode_of(fs: &TestFs, path: &str) -> u32 {
    fs.stat(path.as_bytes(), false).unwrap()[MODE] as u32 & 0o7777
}

fn read(fs: &mut TestFs, path: &str) -> String {
    String::from_utf8(fs.read_file(path.as_bytes()).unwrap().to_vec()).unwrap()
}

/// The error a call failed with: code, system call, and which paths it names.
fn failure<T: core::fmt::Debug>(result: Result<T>) -> (Errno, Syscall, u32) {
    let failure = result.expect_err("expected the call to fail");
    (failure.errno, failure.syscall, failure.path_mode)
}

/// Runs `action` with the checks off, as the kernel's privileged calls are.
fn privileged<T>(fs: &mut TestFs, action: impl FnOnce(&mut TestFs) -> T) -> T {
    fs.checking = false;
    let result = action(fs);
    fs.checking = true;
    result
}

#[test]
fn searches_every_directory_a_path_goes_through() {
    let mut fs = setup();
    mkdir(&mut fs, "/nx");
    mkdir(&mut fs, "/nx/sub");
    put(&mut fs, "/nx/f", "data");
    fs.symlink(b"/nx/f", b"/link").unwrap();
    fs.symlink(b"f", b"/nx/rel").unwrap();
    chmod(&mut fs, "/nx", 0o644);

    // The directory itself, and a trailing slash, look nothing up in it.
    assert_eq!(mode_of(&fs, "/nx"), 0o644);
    fs.stat(b"/nx/", true).unwrap();
    // A name, `.` or `..` looked up in it is refused.
    for path in [
        "/nx/f",
        "/nx/missing",
        "/nx/.",
        "/nx/./",
        "/nx/..",
        "/nx/sub/..",
        "/nx/sub/f",
    ] {
        assert_eq!(
            failure(fs.stat(path.as_bytes(), true)),
            (Eacces, Syscall::Stat, PATH_FIRST),
            "{path}"
        );
    }
    assert_eq!(
        failure(fs.stat(b"/nx/f", false)),
        (Eacces, Syscall::Lstat, PATH_FIRST)
    );
    assert!(!fs.exists(b"/nx/f"));
    // Through a link, the link's target is walked the same way.
    assert_eq!(
        failure(fs.stat(b"/link", true)),
        (Eacces, Syscall::Stat, PATH_FIRST)
    );
    fs.stat(b"/link", false).unwrap();
    assert_eq!(
        failure(fs.realpath(b"/nx/f")),
        (Eacces, Syscall::Realpath, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.readlink(b"/nx/rel")),
        (Eacces, Syscall::Readlink, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.read_file(b"/nx/f")),
        (Eacces, Syscall::Open, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.chmod(b"/nx/f", 0o600, true)),
        (Eacces, Syscall::Chmod, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.utimes(b"/nx/f", Some(1.0), Some(1.0), true)),
        (Eacces, Syscall::Utime, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.access(b"/nx/f", 0)),
        (Eacces, Syscall::Access, PATH_FIRST)
    );
    // Reading the listing needs read, not search.
    let (_, count) = fs.readdir(b"/nx").unwrap();
    assert_eq!(count, 3);

    // A search-only directory can be walked through but not listed.
    chmod(&mut fs, "/nx", 0o311);
    assert_eq!(read(&mut fs, "/nx/f"), "data");
    assert_eq!(read(&mut fs, "/link"), "data");
    assert_eq!(
        failure(fs.readdir(b"/nx")),
        (Eacces, Syscall::Scandir, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.open(b"/nx", O_RDONLY, 0.0)),
        (Eacces, Syscall::Open, PATH_FIRST)
    );

    // The root is a directory like any other.
    chmod(&mut fs, "/", 0o600);
    fs.stat(b"/", true).unwrap();
    fs.stat(b"//", true).unwrap();
    assert_eq!(
        failure(fs.stat(b"/.", true)),
        (Eacces, Syscall::Stat, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.stat(b"/link", false)),
        (Eacces, Syscall::Lstat, PATH_FIRST)
    );
    // The kernel's privileged calls are not checked.
    privileged(&mut fs, |fs| {
        fs.stat(b"/nx/f", true).unwrap();
        chmod(fs, "/", 0o755);
    });
    assert!(fs.exists(b"/nx/f"));
}

#[test]
fn reads_and_writes_by_the_files_own_bits() {
    let mut fs = setup();
    put(&mut fs, "/f", "data");
    chmod(&mut fs, "/f", 0);
    assert_eq!(
        failure(fs.read_file(b"/f")),
        (Eacces, Syscall::Open, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.write_file(b"/f", WRITE, 0o644 as f64, 1)),
        (Eacces, Syscall::Open, PATH_FIRST)
    );
    // Its owner may still look, change its mode and set its times.
    assert_eq!(mode_of(&fs, "/f"), 0);
    fs.utimes(b"/f", Some(5.0), Some(5.0), true).unwrap();
    chmod(&mut fs, "/f", 0o444);
    assert_eq!(read(&mut fs, "/f"), "data");
    for flags in [O_WRONLY, O_RDWR, O_RDONLY | O_TRUNC, 3, O_WRONLY | O_APPEND] {
        assert_eq!(
            failure(fs.open(b"/f", flags, 0.0)),
            (Eacces, Syscall::Open, PATH_FIRST),
            "flags {flags:o}"
        );
    }
    // Refused before it truncates anything.
    assert_eq!(read(&mut fs, "/f"), "data");
    assert_eq!(
        failure(fs.truncate(b"/f", 0.0)),
        (Eacces, Syscall::Open, PATH_FIRST)
    );
    // O_CREAT on a file that is there opens it as it is.
    let handle = fs.open(b"/f", O_RDONLY | O_CREAT, 0.0).unwrap();
    fs.handle_close(handle).unwrap();
    assert_eq!(
        failure(fs.open(b"/f", O_RDONLY | O_CREAT | O_EXCL, 0.0)),
        (Eexist, Syscall::Open, PATH_FIRST)
    );

    chmod(&mut fs, "/f", 0o222);
    assert_eq!(
        failure(fs.read_file(b"/f")),
        (Eacces, Syscall::Open, PATH_FIRST)
    );
    // Truncating by path opens the file for reading and writing, as Node does.
    assert_eq!(
        failure(fs.truncate(b"/f", 0.0)),
        (Eacces, Syscall::Open, PATH_FIRST)
    );
    let handle = fs.open(b"/f", O_WRONLY | O_TRUNC, 0.0).unwrap();
    // An open file is checked when it is opened, not later.
    chmod(&mut fs, "/f", 0);
    fs.handle_write(handle, 2, f64::NAN)
        .unwrap()
        .copy_from_slice(b"ok");
    fs.handle_truncate(handle, 1.0).unwrap();
    fs.handle_chmod(handle, 0o600).unwrap();
    fs.handle_close(handle).unwrap();
    assert_eq!(read(&mut fs, "/f"), "o");

    // A new file is not checked against the mode it is made with.
    let handle = fs.open(b"/new", O_RDWR | O_CREAT, 0o444 as f64).unwrap();
    fs.handle_write(handle, 1, f64::NAN)
        .unwrap()
        .copy_from_slice(b"x");
    fs.handle_close(handle).unwrap();
    assert_eq!(mode_of(&fs, "/new"), 0o444);
    assert_eq!(
        failure(fs.write_file(b"/new", WRITE, 0o644 as f64, 1)),
        (Eacces, Syscall::Open, PATH_FIRST)
    );
    privileged(&mut fs, |fs| put(fs, "/new", "saved"));
    assert_eq!(read(&mut fs, "/new"), "saved");
}

#[test]
fn changes_a_directory_only_with_write_and_search_on_it() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    mkdir(&mut fs, "/d/sub");
    put(&mut fs, "/d/in", "in");
    put(&mut fs, "/out", "out");
    chmod(&mut fs, "/d", 0o555);
    let refused = |result: Result<()>, syscall: Syscall, paths: u32| {
        assert_eq!(failure(result), (Eacces, syscall, paths));
    };
    refused(
        fs.write_file(b"/d/new", WRITE, 0o644 as f64, 0).map(|_| ()),
        Syscall::Open,
        PATH_FIRST,
    );
    refused(
        fs.mkdir(b"/d/m", false, 0o755 as f64).map(|_| ()),
        Syscall::Mkdir,
        PATH_FIRST,
    );
    refused(
        fs.mkdir(b"/d/m/n", true, 0o755 as f64).map(|_| ()),
        Syscall::Mkdir,
        PATH_FIRST,
    );
    refused(fs.unlink(b"/d/in"), Syscall::Unlink, PATH_FIRST);
    refused(fs.rmdir(b"/d/sub"), Syscall::Rmdir, PATH_FIRST);
    refused(fs.rm(b"/d/in", false, true), Syscall::Rm, PATH_FIRST);
    refused(fs.rename(b"/d/in", b"/d/in2"), Syscall::Rename, PATH_BOTH);
    refused(fs.rename(b"/d/in", b"/moved"), Syscall::Rename, PATH_BOTH);
    refused(fs.rename(b"/out", b"/d/out"), Syscall::Rename, PATH_BOTH);
    refused(fs.symlink(b"in", b"/d/l"), Syscall::Symlink, PATH_BOTH);
    refused(fs.link(b"/out", b"/d/hard"), Syscall::Link, PATH_BOTH);
    refused(
        fs.copy_file(b"/out", b"/d/copy", 0),
        Syscall::Copyfile,
        PATH_BOTH,
    );
    refused(
        fs.mkdtemp(b"/d/t-abcdef").map(|_| ()),
        Syscall::Mkdtemp,
        PATH_FIRST,
    );
    // Linux's order: what the name is comes first where it looks the name up
    // first, then the directory's permission, then the kind.
    assert_eq!(
        failure(fs.mkdir(b"/d/sub", false, 0.0)),
        (Eexist, Syscall::Mkdir, PATH_FIRST)
    );
    assert_eq!(fs.mkdir(b"/d/sub", true, 0.0).unwrap(), None);
    assert_eq!(
        failure(fs.unlink(b"/d/nope")),
        (Enoent, Syscall::Unlink, PATH_FIRST)
    );
    refused(fs.unlink(b"/d/sub"), Syscall::Unlink, PATH_FIRST);
    refused(fs.rmdir(b"/d/in"), Syscall::Rmdir, PATH_FIRST);
    assert_eq!(
        failure(fs.symlink(b"x", b"/d/in")),
        (Eexist, Syscall::Symlink, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.link(b"/d", b"/d/in")),
        (Eexist, Syscall::Link, PATH_BOTH)
    );
    refused(fs.link(b"/d/sub", b"/d/l2"), Syscall::Link, PATH_BOTH);
    assert_eq!(
        failure(fs.link(b"/d/sub", b"/l3")),
        (Eperm, Syscall::Link, PATH_BOTH)
    );
    // A file in it can still be changed: that needs only the file's own bits.
    put(&mut fs, "/d/in", "changed");
    // And nothing was made or removed.
    let (_, count) = fs.readdir(b"/d").unwrap();
    assert_eq!(count, 2);
    assert!(fs.check());

    // Search alone is not enough, and neither is write alone.
    chmod(&mut fs, "/d", 0o355);
    put(&mut fs, "/d/made", "1");
    chmod(&mut fs, "/d", 0o655);
    refused(fs.unlink(b"/d/made"), Syscall::Unlink, PATH_FIRST);
    privileged(&mut fs, |fs| fs.unlink(b"/d/made").unwrap());
}

#[test]
fn moves_a_directory_to_another_parent_only_with_write_on_it() {
    let mut fs = setup();
    fs.mkdir(b"/a/mv", true, 0o755 as f64).unwrap();
    mkdir(&mut fs, "/b");
    chmod(&mut fs, "/a/mv", 0o555);
    assert_eq!(
        failure(fs.rename(b"/a/mv", b"/b/mv")),
        (Eacces, Syscall::Rename, PATH_BOTH)
    );
    // Its `..` stays the same within its directory.
    fs.rename(b"/a/mv", b"/a/renamed").unwrap();
    chmod(&mut fs, "/a/renamed", 0o755);
    fs.rename(b"/a/renamed", b"/b/mv").unwrap();
    // A file needs nothing of its own to move.
    put(&mut fs, "/a/f", "f");
    chmod(&mut fs, "/a/f", 0);
    fs.rename(b"/a/f", b"/b/f").unwrap();
    // The kinds and emptiness come after the directories' permissions.
    mkdir(&mut fs, "/b/full");
    put(&mut fs, "/b/full/x", "x");
    mkdir(&mut fs, "/c");
    chmod(&mut fs, "/c", 0o555);
    assert_eq!(
        failure(fs.rename(b"/b/mv", b"/b/full")),
        (Enotempty, Syscall::Rename, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.rename(b"/b/mv", b"/b/f")),
        (Enotdir, Syscall::Rename, PATH_BOTH)
    );
    // A directory's own write comes before whether the target is empty.
    assert_eq!(
        failure(fs.rename(b"/c", b"/b/full")),
        (Eacces, Syscall::Rename, PATH_BOTH)
    );
    chmod(&mut fs, "/b", 0o555);
    assert_eq!(
        failure(fs.rename(b"/b/mv", b"/b/full")),
        (Eacces, Syscall::Rename, PATH_BOTH)
    );
    // The same file under two names is no change, and is not checked.
    fs.rename(b"/b/f", b"/b/f").unwrap();
}

#[test]
fn refuses_a_rename_onto_a_directory_the_source_is_in_before_any_permission() {
    // Linux's rename finds the target above the source (ENOTEMPTY) before it
    // asks whether either directory may be changed, whatever the source is.
    let mut fs = setup();
    fs.mkdir(b"/p/q/r", true, 0o755 as f64).unwrap();
    fs.mkdir(b"/p/q/x/y", true, 0o755 as f64).unwrap();
    put(&mut fs, "/p/q/f", "f");
    let not_empty = (Enotempty, Syscall::Rename, PATH_BOTH);
    for parent_mode in [0o755, 0o555] {
        chmod(&mut fs, "/p", parent_mode);
        for (from, to) in [
            ("/p/q/r", "/p/q"),
            ("/p/q/f", "/p/q"),
            ("/p/q/x/y", "/p/q"),
            ("/p/q/x/y", "/p"),
        ] {
            assert_eq!(
                failure(fs.rename(from.as_bytes(), to.as_bytes())),
                not_empty,
                "{from} -> {to} with /p {parent_mode:o}"
            );
        }
    }
    // The source's own directory unwritable changes nothing either.
    chmod(&mut fs, "/p", 0o755);
    chmod(&mut fs, "/p/q", 0o555);
    assert_eq!(failure(fs.rename(b"/p/q/r", b"/p/q")), not_empty);
    // The other way round is still EINVAL, and a target beside the source is
    // still asked about its directory.
    assert_eq!(
        failure(fs.rename(b"/p/q", b"/p/q/r/in")),
        (Einval, Syscall::Rename, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.rename(b"/p/q/r", b"/p/q/x")),
        (Eacces, Syscall::Rename, PATH_BOTH)
    );
    assert_eq!(
        listing(&mut fs, "/p"),
        ["q/", "q/f", "q/r/", "q/x/", "q/x/y/"]
    );
    assert!(fs.check());
}

/// The names `readdir` lists for `path`, in its order.
fn names(fs: &mut TestFs, path: &str) -> Vec<String> {
    let (bytes, _) = fs.readdir(path.as_bytes()).unwrap();
    let mut names = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let length = u32::from_le_bytes(bytes[at + 1..at + 5].try_into().unwrap()) as usize;
        names.push(String::from_utf8(bytes[at + 5..at + 5 + length].to_vec()).unwrap());
        at += 5 + length;
    }
    names
}

#[test]
fn lists_and_removes_names_in_the_order_of_their_code_points() {
    // 😀 is U+1F600 (UTF-8 F0.., UTF-16 D83D DE00) and ｱ is U+FF71 (UTF-8
    // EF.., UTF-16 FF71): by code point and by UTF-8 byte ｱ comes first, by
    // UTF-16 unit 😀 does. vfs.ts lists and removes in this order too.
    let mut fs = setup();
    fs.mkdir("/t/ｱ".as_bytes(), true, 0o755 as f64).unwrap();
    put(&mut fs, "/t/ｱ/in", "x");
    for name in ["😀", "é", "z", "\u{10000}", "\u{e000}", "\u{d7ff}"] {
        put(&mut fs, &std::format!("/t/{name}"), "x");
    }
    assert_eq!(
        names(&mut fs, "/t"),
        ["z", "é", "\u{d7ff}", "\u{e000}", "ｱ", "\u{10000}", "😀"]
    );
    // The removal stops at ｱ, which may not be emptied: only what readdir
    // lists before it is gone.
    chmod(&mut fs, "/t/ｱ", 0o555);
    assert_eq!(
        failure(fs.rm(b"/t", true, false)),
        (Eacces, Syscall::Rm, PATH_FIRST)
    );
    assert_eq!(names(&mut fs, "/t"), ["ｱ", "\u{10000}", "😀"]);
    assert!(fs.check());
}

/// Everything below `path`, relative to it, a directory with a trailing `/`.
fn listing(fs: &mut TestFs, path: &str) -> Vec<String> {
    let entries: Vec<(String, u8)> = privileged(fs, |fs| {
        let (bytes, _) = fs.readdir(path.as_bytes()).unwrap();
        let mut entries = Vec::new();
        let mut at = 0;
        while at < bytes.len() {
            let length = u32::from_le_bytes(bytes[at + 1..at + 5].try_into().unwrap()) as usize;
            let name = String::from_utf8_lossy(&bytes[at + 5..at + 5 + length]).into_owned();
            entries.push((name, bytes[at]));
            at += 5 + length;
        }
        entries
    });
    let mut out = Vec::new();
    for (name, kind) in entries {
        if kind == KIND_DIR {
            out.push(std::format!("{name}/"));
            let below = listing(fs, &std::format!("{path}/{name}"));
            out.extend(
                below
                    .into_iter()
                    .map(|inner| std::format!("{name}/{inner}")),
            );
        } else {
            out.push(name);
        }
    }
    out.sort();
    out
}

#[test]
fn removes_a_tree_in_name_order_up_to_the_first_refusal_and_its_entry_last() {
    let mut fs = setup();
    fs.mkdir(b"/t/a", true, 0o755 as f64).unwrap();
    put(&mut fs, "/t/a/f1", "1");
    fs.mkdir(b"/t/b/d", true, 0o755 as f64).unwrap();
    put(&mut fs, "/t/b/d/f3", "3");
    put(&mut fs, "/t/b/f2", "2");
    fs.mkdir(b"/t/c", true, 0o755 as f64).unwrap();
    put(&mut fs, "/t/c/f4", "4");
    put(&mut fs, "/t/top", "t");
    chmod(&mut fs, "/t/b", 0o555);
    // As Node's rm on Linux: entry by entry in the order readdir lists them,
    // a directory's contents first, up to the first refusal. a goes; b/d is
    // emptied, then b refuses to let it go.
    assert_eq!(
        failure(fs.rm(b"/t", true, true)),
        (Eacces, Syscall::Rm, PATH_FIRST)
    );
    assert_eq!(
        listing(&mut fs, "/t"),
        ["b/", "b/d/", "b/f2", "c/", "c/f4", "top"]
    );
    assert!(fs.check());
    // A directory it may not read stops it too, even an empty one: Node's rm
    // opens each.
    chmod(&mut fs, "/t/b", 0o755);
    fs.mkdir(b"/t/c/empty", false, 0o755 as f64).unwrap();
    chmod(&mut fs, "/t/c/empty", 0o311);
    assert_eq!(
        failure(fs.rm(b"/t", true, false)),
        (Eacces, Syscall::Rm, PATH_FIRST)
    );
    assert_eq!(listing(&mut fs, "/t"), ["c/", "c/empty/", "c/f4", "top"]);
    assert_eq!(
        failure(fs.rm(b"/t/c/empty", true, false)),
        (Eacces, Syscall::Rm, PATH_FIRST)
    );
    assert!(fs.check());
    // A directory inside one it may not search is not opened: what it holds
    // stays, though that directory itself could be emptied.
    fs.mkdir(b"/t/c/empty/in", false, 0o755 as f64).unwrap();
    put(&mut fs, "/t/c/empty/in/f5", "5");
    chmod(&mut fs, "/t/c/empty", 0o666);
    assert_eq!(
        failure(fs.rm(b"/t/c/empty", true, false)),
        (Eacces, Syscall::Rm, PATH_FIRST)
    );
    assert_eq!(listing(&mut fs, "/t/c/empty"), ["in/", "in/f5"]);
    privileged(&mut fs, |fs| fs.rm(b"/t/c/empty/in", true, false).unwrap());
    assert!(fs.check());
    // An empty one needs only read; a file needs nothing.
    chmod(&mut fs, "/t/c/empty", 0o444);
    chmod(&mut fs, "/t/c/f4", 0);
    // The tree goes, then its own entry, which its directory may refuse.
    chmod(&mut fs, "/", 0o555);
    assert_eq!(
        failure(fs.rm(b"/t", true, false)),
        (Eacces, Syscall::Rm, PATH_FIRST)
    );
    assert!(fs.exists(b"/t"));
    let (_, count) = fs.readdir(b"/t").unwrap();
    assert_eq!(count, 0);
    assert!(fs.check());
    chmod(&mut fs, "/", 0o755);
    fs.rm(b"/t", true, false).unwrap();
    assert!(!fs.exists(b"/t"));
    assert_eq!(fs.totals(), (1, 0));
    // The kernel removes whatever the modes.
    fs.mkdir(b"/u/v", true, 0o755 as f64).unwrap();
    put(&mut fs, "/u/v/w", "w");
    chmod(&mut fs, "/u/v", 0);
    chmod(&mut fs, "/u", 0);
    privileged(&mut fs, |fs| fs.rm(b"/u", true, false).unwrap());
    assert_eq!(fs.totals(), (1, 0));
}

#[test]
fn copies_from_a_readable_file_to_a_writable_place() {
    let mut fs = setup();
    put(&mut fs, "/src", "data");
    put(&mut fs, "/dst", "old");
    chmod(&mut fs, "/src", 0o222);
    assert_eq!(
        failure(fs.copy_file(b"/src", b"/new", 0)),
        (Eacces, Syscall::Copyfile, PATH_BOTH)
    );
    chmod(&mut fs, "/src", 0o444);
    fs.copy_file(b"/src", b"/new", 0).unwrap();
    // The copy keeps the source's mode.
    assert_eq!(mode_of(&fs, "/new"), 0o444);
    chmod(&mut fs, "/dst", 0o444);
    assert_eq!(
        failure(fs.copy_file(b"/src", b"/dst", 0)),
        (Eacces, Syscall::Copyfile, PATH_BOTH)
    );
    assert_eq!(read(&mut fs, "/dst"), "old");
    // Onto itself the destination is opened for writing first.
    assert_eq!(
        failure(fs.copy_file(b"/src", b"/src", 0)),
        (Eacces, Syscall::Copyfile, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.copy_file(b"/src", b"/dst", COPYFILE_EXCL)),
        (Eexist, Syscall::Copyfile, PATH_BOTH)
    );
}

#[test]
fn asks_the_destination_of_a_copy_before_it_finds_a_source_that_is_no_file() {
    // libuv opens the source, then the destination, and only reading a
    // directory fails (EISDIR): whatever refuses the destination comes first.
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    put(&mut fs, "/f", "old");
    put(&mut fs, "/wo", "old");
    mkdir(&mut fs, "/ro");
    mkdir(&mut fs, "/nx");
    chmod(&mut fs, "/wo", 0o444);
    chmod(&mut fs, "/ro", 0o555);
    chmod(&mut fs, "/nx", 0o600);
    let copy = |fs: &mut TestFs, to: &str, mode: u32| {
        let (errno, syscall, paths) = failure(fs.copy_file(b"/d", to.as_bytes(), mode));
        assert_eq!((syscall, paths), (Syscall::Copyfile, PATH_BOTH), "{to}");
        errno
    };
    assert_eq!(copy(&mut fs, "/nope/x", 0), Enoent);
    assert_eq!(copy(&mut fs, "/f", COPYFILE_EXCL), Eexist);
    assert_eq!(copy(&mut fs, "/ro/new", 0), Eacces);
    assert_eq!(copy(&mut fs, "/nx/new", 0), Eacces);
    assert_eq!(copy(&mut fs, "/wo", 0), Eacces);
    // Then the directory: nothing is made, and what was there is kept.
    for to in ["/f", "/new", "/new/", "/d"] {
        assert_eq!(copy(&mut fs, to, 0), Eisdir, "{to}");
    }
    assert_eq!(read(&mut fs, "/f"), "old");
    assert!(!fs.exists(b"/new"));
    // A directory it may not read is refused as the source, first of all.
    chmod(&mut fs, "/d", 0o311);
    assert_eq!(copy(&mut fs, "/nope/x", 0), Eacces);
    assert!(fs.check());
}

#[test]
fn answers_access_by_the_owner_bits() {
    let mut fs = setup();
    put(&mut fs, "/f", "x");
    mkdir(&mut fs, "/d");
    let allowed = |fs: &TestFs, path: &[u8], mode: u32| fs.access(path, mode).is_ok();
    chmod(&mut fs, "/f", 0o100);
    assert!(allowed(&fs, b"/f", X_OK));
    assert!(allowed(&fs, b"/f", 0));
    assert!(!allowed(&fs, b"/f", R_OK | X_OK));
    chmod(&mut fs, "/f", 0o077);
    for mode in [R_OK, W_OK, X_OK] {
        assert!(!allowed(&fs, b"/f", mode), "{mode}");
    }
    chmod(&mut fs, "/f", 0o600);
    assert!(allowed(&fs, b"/f", R_OK | W_OK));
    assert!(!allowed(&fs, b"/f", X_OK));
    // A directory's x is search.
    assert!(allowed(&fs, b"/d", R_OK | W_OK | X_OK));
    chmod(&mut fs, "/d", 0o600);
    assert_eq!(
        failure(fs.access(b"/d", X_OK)),
        (Eacces, Syscall::Access, PATH_FIRST)
    );
    // Unchecked, access answers as for root: a file runs only with an x bit.
    privileged(&mut fs, |fs| {
        assert!(fs.access(b"/d", X_OK).is_ok());
        assert!(fs.access(b"/f", R_OK | W_OK).is_ok());
        assert!(fs.access(b"/f", X_OK).is_err());
        chmod(fs, "/f", 0o010);
        assert!(fs.access(b"/f", X_OK).is_ok());
    });
}

#[test]
fn watches_only_what_it_may_read() {
    let mut fs = setup();
    put(&mut fs, "/f", "x");
    chmod(&mut fs, "/f", 0o200);
    assert_eq!(
        failure(fs.watch_path(b"/f")),
        (Eacces, Syscall::Watch, PATH_FIRST)
    );
    privileged(&mut fs, |fs| {
        assert_eq!(fs.watch_path(b"/f").unwrap(), b"/f")
    });
}

#[test]
fn a_directory_root_owns_answers_by_its_others_bits() {
    let mut fs = setup();
    mkdir(&mut fs, "/dev");
    put(&mut fs, "/dev/kept", "k");
    fs.symlink(b"/dev", b"/devlink").unwrap();
    // Only the unchecked view gives a node to root.
    assert_eq!(
        failure(fs.give_to_root(b"/dev")),
        (Eperm, Syscall::Chown, PATH_FIRST)
    );
    assert_eq!(fs.stat(b"/dev", true).unwrap()[4], UID);
    privileged(&mut fs, |fs| fs.give_to_root(b"/dev").unwrap());
    let stat = fs.stat(b"/dev", true).unwrap();
    assert_eq!(
        (stat[2] as u32 & 0o7777, stat[4], stat[5]),
        (0o755, 0.0, 0.0)
    );
    assert_eq!(fs.stat(b"/devlink", false).unwrap()[4], UID);
    assert_eq!(fs.stat(b"/dev/kept", true).unwrap()[4], UID);

    // The owner's bits are 7, but the others' (r-x) decide.
    assert!(fs.access(b"/dev", R_OK | X_OK).is_ok());
    assert_eq!(
        failure(fs.access(b"/dev", W_OK)),
        (Eacces, Syscall::Access, PATH_FIRST)
    );
    assert_eq!(fs.readdir(b"/dev").unwrap().1, 1);
    for path in ["/dev/x", "/devlink/x"] {
        assert_eq!(
            failure(fs.open(path.as_bytes(), WRITE | O_EXCL, 0o644 as f64)),
            (Eacces, Syscall::Open, PATH_FIRST),
            "{path}"
        );
        assert_eq!(
            failure(fs.mkdir(path.as_bytes(), false, 0o755 as f64)),
            (Eacces, Syscall::Mkdir, PATH_FIRST),
            "{path}"
        );
        assert_eq!(
            failure(fs.symlink(b"/tmp", path.as_bytes())),
            (Eacces, Syscall::Symlink, PATH_BOTH),
            "{path}"
        );
    }
    assert_eq!(
        failure(fs.mkdir(b"/dev/a/b", true, 0o755 as f64)),
        (Eacces, Syscall::Mkdir, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.unlink(b"/dev/kept")),
        (Eacces, Syscall::Unlink, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.rename(b"/dev/kept", b"/kept")),
        (Eacces, Syscall::Rename, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.rm(b"/dev/kept", false, true)),
        (Eacces, Syscall::Rm, PATH_FIRST)
    );
    fs.rm(b"/dev/missing", false, true).unwrap();
    // The owner alone changes its mode and times, by path or open file.
    for mode in [0o755, 0o777] {
        assert_eq!(
            failure(fs.chmod(b"/dev", mode, true)),
            (Eperm, Syscall::Chmod, PATH_FIRST)
        );
    }
    assert_eq!(
        failure(fs.chmod(b"/devlink", 0o777, true)),
        (Eperm, Syscall::Chmod, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.utimes(b"/dev", Some(1.0), Some(1.0), true)),
        (Eperm, Syscall::Utime, PATH_FIRST)
    );
    let handle = fs.open(b"/dev", O_RDONLY, 0.0).unwrap();
    assert_eq!(
        failure(fs.handle_chmod(handle, 0o777)),
        (Eperm, Syscall::Fchmod, PATH_NONE)
    );
    assert_eq!(
        failure(fs.handle_utimes(handle, 1.0, 1.0)),
        (Eperm, Syscall::Futime, PATH_NONE)
    );
    fs.handle_close(handle).unwrap();
    assert_eq!(mode_of(&fs, "/dev"), 0o755);
    // What it holds stays the user's.
    chmod(&mut fs, "/dev/kept", 0o600);
    assert_eq!(read(&mut fs, "/dev/kept"), "k");
    // Unchecked calls are root's.
    privileged(&mut fs, |fs| {
        put(fs, "/dev/made", "m");
        chmod(fs, "/dev", 0o700);
    });
    assert_eq!(
        failure(fs.readdir(b"/dev")),
        (Eacces, Syscall::Scandir, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.stat(b"/dev/kept", true)),
        (Eacces, Syscall::Stat, PATH_FIRST)
    );
    assert!(fs.check());
}

#[test]
fn keeps_the_entry_of_a_node_root_owns_whatever_path_reaches_it() {
    let mut fs = setup();
    privileged(&mut fs, |fs| {
        mkdir(fs, "/dev");
        put(fs, "/dev/kept", "k");
        fs.give_to_root(b"/dev").unwrap();
    });
    // `/` is the user's: only the rule for root's node refuses these.
    fs.symlink(b"/", b"/root").unwrap();
    mkdir(&mut fs, "/empty");
    for path in ["/dev", "/root/dev", "/root/dev/"] {
        let bytes = path.as_bytes();
        assert_eq!(
            failure(fs.rmdir(bytes)),
            (Eacces, Syscall::Rmdir, PATH_FIRST),
            "{path}"
        );
        assert_eq!(
            failure(fs.rm(bytes, true, true)),
            (Eacces, Syscall::Rm, PATH_FIRST),
            "{path}"
        );
        assert_eq!(
            failure(fs.rename(bytes, b"/moved")),
            (Eacces, Syscall::Rename, PATH_BOTH),
            "{path}"
        );
        assert_eq!(
            failure(fs.rename(b"/empty", bytes)),
            (Eacces, Syscall::Rename, PATH_BOTH),
            "{path}"
        );
    }
    // Before the kind, as Linux's `may_delete`: not EISDIR.
    assert_eq!(
        failure(fs.unlink(b"/root/dev")),
        (Eacces, Syscall::Unlink, PATH_FIRST)
    );
    assert_eq!(fs.stat(b"/dev/kept", true).unwrap()[4], UID);
    // The unchecked calls are root's.
    privileged(&mut fs, |fs| fs.rename(b"/root/dev", b"/dev2").unwrap());
    assert!(fs.stat(b"/dev", true).is_err());
    assert!(fs.check());
}

#[test]
fn hard_links_a_node_root_owns_only_as_protected_hard_links_allow_by_any_path() {
    let mut fs = setup();
    privileged(&mut fs, |fs| {
        mkdir(fs, "/dev");
        // A device's entry, as the kernel makes it: a link of root's to itself.
        fs.symlink(b"/dev/null", b"/dev/null").unwrap();
        for (name, bits) in [
            ("shared", 0o666),
            ("readable", 0o644),
            ("setuid", 0o4666),
            ("setgid", 0o2676),
        ] {
            let path = format!("/dev/{name}");
            put(fs, &path, name);
            chmod(fs, &path, bits);
            fs.give_to_root(path.as_bytes()).unwrap();
        }
        fs.give_to_root(b"/dev/null").unwrap();
        fs.give_to_root(b"/dev").unwrap();
    });
    fs.symlink(b"/", b"/r").unwrap();
    fs.symlink(b"/dev", b"/d").unwrap();
    mkdir(&mut fs, "/h");
    let eperm = (Eperm, Syscall::Link, PATH_BOTH);
    for dir in ["/dev", "/r/dev", "/d", "/r/d"] {
        for name in ["null", "readable", "setuid", "setgid"] {
            let from = format!("{dir}/{name}");
            assert_eq!(failure(fs.link(from.as_bytes(), b"/h/x")), eperm, "{from}");
        }
        let itself = if dir == "/dev" {
            String::from("/dev")
        } else {
            format!("{dir}/.")
        };
        assert_eq!(
            failure(fs.link(itself.as_bytes(), b"/h/x")),
            eperm,
            "{itself}"
        );
    }
    assert_eq!(names(&mut fs, "/h"), Vec::<String>::new());
    // A plain file the user may read and write is linked, by any path.
    fs.link(b"/d/shared", b"/h/s").unwrap();
    assert_eq!(read(&mut fs, "/h/s"), "shared");
    // After the new name (EEXIST), before its directory's permission (EACCES).
    assert_eq!(failure(fs.link(b"/d/null", b"/h/s")).0, Eexist);
    assert_eq!(failure(fs.link(b"/d/null", b"/dev/y")), eperm);
    // The unchecked calls are root's.
    privileged(&mut fs, |fs| fs.link(b"/d/null", b"/h/n").unwrap());
    assert_eq!(fs.stat(b"/h/n", false).unwrap()[4], ROOT_ID);
}

#[test]
fn sets_the_times_of_a_node_root_owns_to_now_only_where_it_may_write() {
    let mut fs = setup();
    privileged(&mut fs, |fs| {
        mkdir(fs, "/dev");
        put(fs, "/open", "o");
        chmod(fs, "/open", 0o666);
        fs.give_to_root(b"/dev").unwrap();
        fs.give_to_root(b"/open").unwrap();
    });
    assert_eq!(
        failure(fs.utimes(b"/open", Some(1.0), Some(1.0), true)),
        (Eperm, Syscall::Utime, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.utimes(b"/open", None, Some(1.0), true)),
        (Eperm, Syscall::Utime, PATH_FIRST)
    );
    fs.utimes(b"/open", None, None, true).unwrap();
    let stat = fs.stat(b"/open", true).unwrap();
    // One clock read: both times and the change time are that moment.
    assert_eq!((stat[10], stat[11]), (stat[12], stat[12]));
    assert_eq!(
        failure(fs.utimes(b"/dev", None, None, true)),
        (Eacces, Syscall::Utime, PATH_FIRST)
    );
    // The owner needs no write permission for it.
    put(&mut fs, "/mine", "m");
    chmod(&mut fs, "/mine", 0o444);
    fs.utimes(b"/mine", None, None, true).unwrap();
    assert!(fs.check());
}
