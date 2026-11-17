//! The cases of `kernel/vfs/vfs.test.ts`, on this port, plus what only the port
//! has (bytes for names, handles as numbers, the event log, fallible growth).
//! Every helper checks the tree's invariants after the operation it runs.
use super::*;
use crate::abi::{Errno::*, Syscall};
use std::string::String;

const WRITE: u32 = O_WRONLY | O_CREAT | O_TRUNC;
const NO_POSITION: f64 = f64::NAN;

const INO: usize = 1;
const MODE: usize = 2;
const NLINK: usize = 3;
const SIZE: usize = 7;
const BLKSIZE_AT: usize = 8;
const BLOCKS: usize = 9;
const ATIME: usize = 10;
const MTIME: usize = 11;
const CTIME: usize = 12;
const BIRTHTIME: usize = 13;
const S_IFMT: u32 = 0o170000;

/// A clock that stands still until a test moves it, and counts its readings.
struct TestClock {
    time: f64,
    calls: u32,
}

impl Clock for TestClock {
    fn now(&mut self) -> f64 {
        self.calls += 1;
        self.time
    }
}

type TestFs = Fs<TestClock>;

fn setup() -> TestFs {
    Fs::new(TestClock {
        time: 1000.0,
        calls: 0,
    })
}

fn tick(fs: &mut TestFs, ms: f64) -> f64 {
    fs.clock.time += ms;
    fs.clock.time
}

/// Fails the test when the tree is inconsistent; returns `value` otherwise.
fn checked<T>(fs: &TestFs, value: T) -> T {
    assert!(fs.check(), "the tree's invariants do not hold");
    value
}

fn try_put(fs: &mut TestFs, path: &str, content: &[u8], flags: u32, mode: f64) -> Result<()> {
    let result = fs
        .write_file(path.as_bytes(), flags, mode, content.len())
        .map(|room| room.copy_from_slice(content));
    checked(fs, result)
}

fn put(fs: &mut TestFs, path: &str, content: &str) {
    try_put(fs, path, content.as_bytes(), WRITE, 0o666 as f64).unwrap();
}

fn read_bytes(fs: &mut TestFs, path: &str) -> Vec<u8> {
    let bytes = fs.read_file(path.as_bytes()).unwrap().to_vec();
    checked(fs, bytes)
}

fn read(fs: &mut TestFs, path: &str) -> String {
    String::from_utf8(read_bytes(fs, path)).unwrap()
}

fn stat(fs: &TestFs, path: &str, follow: bool) -> Stat {
    fs.stat(path.as_bytes(), follow).unwrap()
}

fn kind_of(stat: &Stat) -> u32 {
    stat[MODE] as u32 & S_IFMT
}

fn mkdir(fs: &mut TestFs, path: &str) {
    let result = fs.mkdir(path.as_bytes(), false, 0o777 as f64).map(|_| ());
    checked(fs, result).unwrap();
}

fn mkdir_p(fs: &mut TestFs, path: &str) -> Option<String> {
    let made = fs
        .mkdir(path.as_bytes(), true, 0o777 as f64)
        .unwrap()
        .map(|first| String::from_utf8(first.to_vec()).unwrap());
    checked(fs, made)
}

fn symlink(fs: &mut TestFs, target: &str, path: &str) {
    let result = fs.symlink(target.as_bytes(), path.as_bytes());
    checked(fs, result).unwrap();
}

fn open(fs: &mut TestFs, path: &str, flags: u32, mode: f64) -> u32 {
    let result = fs.open(path.as_bytes(), flags, mode);
    checked(fs, result).unwrap()
}

fn write(fs: &mut TestFs, handle: u32, content: &str, position: f64) -> Result<()> {
    let result = fs
        .handle_write(handle, content.len(), position)
        .map(|room| room.copy_from_slice(content.as_bytes()));
    checked(fs, result)
}

fn read_at(fs: &mut TestFs, handle: u32, length: f64, position: f64) -> String {
    let bytes = fs.handle_read(handle, length, position).unwrap().to_vec();
    checked(fs, String::from_utf8(bytes).unwrap())
}

fn close(fs: &mut TestFs, handle: u32) {
    let result = fs.handle_close(handle);
    checked(fs, result).unwrap();
}

/// The error a call failed with: code, system call, and which paths it names.
fn failure<T: core::fmt::Debug>(result: Result<T>) -> (Errno, Syscall, u32) {
    let failure = result.expect_err("expected the call to fail");
    (failure.errno, failure.syscall, failure.path_mode)
}

fn exists(fs: &TestFs, path: &str) -> bool {
    fs.exists(path.as_bytes())
}

fn listing(fs: &mut TestFs, path: &str) -> Vec<(String, u8)> {
    let (bytes, count) = fs.readdir(path.as_bytes()).unwrap();
    let mut entries = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let length = u32::from_le_bytes(bytes[at + 1..at + 5].try_into().unwrap()) as usize;
        let name = String::from_utf8_lossy(&bytes[at + 5..at + 5 + length]).into_owned();
        entries.push((name, bytes[at]));
        at += 5 + length;
    }
    assert_eq!(entries.len(), count as usize);
    entries.sort();
    entries
}

/// The logged events, oldest first, as (type, path); empties the log.
fn take_events(fs: &mut TestFs) -> Vec<(u8, String)> {
    let bytes = fs.events();
    let mut events = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let length = u32::from_le_bytes(bytes[at + 1..at + 5].try_into().unwrap()) as usize;
        let path = String::from_utf8_lossy(&bytes[at + 5..at + 5 + length]).into_owned();
        events.push((bytes[at], path));
        at += 5 + length;
    }
    fs.clear_events();
    events
}

fn renamed(path: &str) -> (u8, String) {
    (EVENT_RENAME, path.into())
}

fn changed(path: &str) -> (u8, String) {
    (EVENT_CHANGE, path.into())
}

/// How many times the clock is read while `action` runs.
fn clock_reads(fs: &mut TestFs, action: impl FnOnce(&mut TestFs)) -> u32 {
    let before = fs.clock.calls;
    action(fs);
    fs.clock.calls - before
}

// ---- root and paths ----

#[test]
fn has_a_root_directory_with_mode_0755() {
    let mut fs = setup();
    assert_eq!(stat(&fs, "/", true)[MODE] as u32, S_IFDIR | 0o755);
    assert_eq!(listing(&mut fs, "/"), vec![]);
    assert_eq!(stat(&fs, "/", true)[INO], 1.0);
    assert_eq!(fs.clock.calls, 1);
    checked(&fs, ());
}

#[test]
fn rejects_relative_paths_and_empty_ones() {
    let fs = setup();
    assert_eq!(
        failure(fs.stat(b"a/b", true)),
        (Einval, Syscall::Stat, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.stat(b"", true)),
        (Enoent, Syscall::Stat, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.stat(b"", false)),
        (Enoent, Syscall::Lstat, PATH_FIRST)
    );
}

#[test]
fn normalizes_slashes_dots_and_dot_dots() {
    let mut fs = setup();
    mkdir(&mut fs, "/a");
    put(&mut fs, "/a/f", "x");
    assert_eq!(read(&mut fs, "//a/.//f"), "x");
    assert_eq!(read(&mut fs, "/a/../a/./f"), "x");
    assert_eq!(read(&mut fs, "/../../a/f"), "x");
    assert_eq!(failure(fs.stat(b"/missing/../", true)).0, Enoent);
}

#[test]
fn requires_a_directory_for_a_trailing_slash() {
    let mut fs = setup();
    put(&mut fs, "/f", "x");
    assert_eq!(
        failure(fs.stat(b"/f/", true)),
        (Enotdir, Syscall::Stat, PATH_FIRST)
    );
    assert_eq!(failure(fs.read_file(b"/f/.")).0, Enotdir);
    mkdir(&mut fs, "/d");
    assert_eq!(kind_of(&stat(&fs, "/d/", true)), S_IFDIR);
}

#[test]
fn reports_enotdir_when_a_middle_component_is_a_file() {
    let mut fs = setup();
    put(&mut fs, "/f", "x");
    assert_eq!(
        failure(fs.stat(b"/f/x", true)),
        (Enotdir, Syscall::Stat, PATH_FIRST)
    );
    assert_eq!(
        failure(try_put(&mut fs, "/f/x", b"y", WRITE, 0o666 as f64)),
        (Enotdir, Syscall::Open, PATH_FIRST)
    );
}

#[test]
fn takes_any_bytes_as_a_name() {
    let mut fs = setup();
    let name = b"/\xff\xfe\x00name";
    fs.write_file(name, WRITE, 0o644 as f64, 2)
        .unwrap()
        .copy_from_slice(b"hi");
    assert_eq!(fs.read_file(name).unwrap(), b"hi");
    let (bytes, count) = fs.readdir(b"/").unwrap();
    assert_eq!(count, 1);
    assert_eq!(&bytes[5..], b"\xff\xfe\x00name");
    assert_eq!(fs.realpath(name).unwrap(), name);
    checked(&fs, ());
}

// ---- files ----

#[test]
fn writes_and_reads_a_file() {
    let mut fs = setup();
    put(&mut fs, "/hello.txt", "hello");
    assert_eq!(read(&mut fs, "/hello.txt"), "hello");
    assert!(exists(&fs, "/hello.txt"));
    assert!(!exists(&fs, "/nope"));
}

#[test]
fn creates_files_with_the_umask_applied() {
    let mut fs = setup();
    put(&mut fs, "/f", "");
    assert_eq!(stat(&fs, "/f", true)[MODE] as u32, S_IFREG | 0o644);
    try_put(&mut fs, "/g", b"", WRITE, 0o777 as f64).unwrap();
    assert_eq!(stat(&fs, "/g", true)[MODE] as u32, S_IFREG | 0o755);
    try_put(&mut fs, "/h", b"", WRITE, 0.5).unwrap();
    assert_eq!(stat(&fs, "/h", true)[MODE] as u32, S_IFREG | 0o644);
}

#[test]
fn creation_mode_follows_javascript_numbers() {
    assert_eq!(creation_mode(0o777 as f64, 1), 0o755);
    assert_eq!(creation_mode(-1.0, 1), 1);
    assert_eq!(creation_mode(f64::NAN, 1), 1);
    assert_eq!(creation_mode(f64::INFINITY, 1), 1);
    assert_eq!(creation_mode(1.5, 1), 1);
    assert_eq!(creation_mode(2147483648.0 + 0o640 as f64, 1), 0o640);
    assert_eq!(creation_mode(4294967296.0 + 0o700 as f64, 1), 0o700);
    assert_eq!(creation_mode(1e300, 1), 0);
    assert_eq!(js::to_int32(1e20), 1661992960);
    assert_eq!(js::to_int32(-1.0), -1);
    assert_eq!(js::to_int32(-2.5), -2);
    assert_eq!(js::to_int32(2147483648.0), -2147483648);
    assert_eq!(js::to_int32(4294967301.0), 5);
    assert_eq!(js::to_int32(f64::MIN_POSITIVE / 2.0), 0);
    assert_eq!(js::floor(-0.5), -1.0);
    assert_eq!(js::floor(2.9), 2.0);
}

#[test]
fn reports_size_blocks_and_identity_in_stat() {
    let mut fs = setup();
    put(&mut fs, "/f", &"x".repeat(1025));
    let stat = stat(&fs, "/f", true);
    assert_eq!(stat[SIZE], 1025.0);
    assert_eq!(stat[BLOCKS], 3.0);
    assert_eq!(stat[BLKSIZE_AT], 4096.0);
    assert_eq!(&stat[..INO], &[1.0]);
    assert_eq!(&stat[4..7], &[1.0, 1.0, 0.0]);
    assert_eq!(stat[NLINK], 1.0);
}

#[test]
fn numbers_inodes_uniquely_and_never_reuses_a_number() {
    let mut fs = setup();
    put(&mut fs, "/a", "");
    put(&mut fs, "/b", "");
    let a = stat(&fs, "/a", true)[INO];
    assert_ne!(stat(&fs, "/b", true)[INO], a);
    fs.rename(b"/a", b"/c").unwrap();
    assert_eq!(stat(&fs, "/c", true)[INO], a);
    fs.unlink(b"/b").unwrap();
    put(&mut fs, "/d", "");
    assert_eq!(stat(&fs, "/d", true)[INO], 4.0);
}

#[test]
fn overwrites_and_appends_with_write_file() {
    let mut fs = setup();
    put(&mut fs, "/f", "long content");
    put(&mut fs, "/f", "short");
    assert_eq!(read(&mut fs, "/f"), "short");
    put(&mut fs, "/g", "a");
    try_put(
        &mut fs,
        "/g",
        b"b",
        O_WRONLY | O_CREAT | O_APPEND,
        0o644 as f64,
    )
    .unwrap();
    try_put(
        &mut fs,
        "/g",
        b"c",
        O_WRONLY | O_CREAT | O_APPEND,
        0o644 as f64,
    )
    .unwrap();
    assert_eq!(read(&mut fs, "/g"), "abc");
}

#[test]
fn raises_the_errors_of_read_file_and_write_file() {
    let mut fs = setup();
    assert_eq!(
        failure(fs.read_file(b"/nope")),
        (Enoent, Syscall::Open, PATH_FIRST)
    );
    mkdir(&mut fs, "/d");
    assert_eq!(
        failure(fs.read_file(b"/d")),
        (Eisdir, Syscall::Read, PATH_NONE)
    );
    assert_eq!(
        failure(try_put(&mut fs, "/d", b"x", WRITE, 0.0)),
        (Eisdir, Syscall::Open, PATH_FIRST)
    );
    assert_eq!(
        failure(try_put(&mut fs, "/new/", b"x", WRITE, 0.0)),
        (Eisdir, Syscall::Open, PATH_FIRST)
    );
    assert_eq!(
        failure(try_put(&mut fs, "/no/f", b"x", WRITE, 0.0)),
        (Enoent, Syscall::Open, PATH_FIRST)
    );
}

#[test]
fn write_file_checks_the_access_mode_only_when_there_is_data() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    try_put(&mut fs, "/d", b"", O_RDONLY, 0.0).unwrap();
    assert_eq!(
        failure(try_put(&mut fs, "/d", b"x", O_RDONLY, 0.0)),
        (Ebadf, Syscall::Write, PATH_NONE)
    );
    put(&mut fs, "/f", "abc");
    assert_eq!(
        failure(try_put(&mut fs, "/f", b"x", O_RDONLY, 0.0)),
        (Ebadf, Syscall::Write, PATH_NONE)
    );
    assert_eq!(read(&mut fs, "/f"), "abc");
}

#[test]
fn reads_a_large_file_in_place() {
    let mut fs = setup();
    let data = vec![7u8; 1 << 20];
    try_put(&mut fs, "/big", &data, WRITE, 0o644 as f64).unwrap();
    let first = fs.read_file(b"/big").unwrap().as_ptr();
    let second = fs.read_file(b"/big").unwrap();
    assert_eq!(second.as_ptr(), first);
    assert_eq!(second, &data[..]);
    assert_eq!(fs.totals(), (2, 1 << 20));
}

// ---- open files ----

#[test]
fn reads_and_writes_at_the_file_offset() {
    let mut fs = setup();
    let file = open(&mut fs, "/f", O_RDWR | O_CREAT, 0o644 as f64);
    write(&mut fs, file, "hello", NO_POSITION).unwrap();
    write(&mut fs, file, " world", NO_POSITION).unwrap();
    assert_eq!(read_at(&mut fs, file, 5.0, 0.0), "hello");
    assert_eq!(read_at(&mut fs, file, 100.0, NO_POSITION), "");
    close(&mut fs, file);
    let reader = open(&mut fs, "/f", O_RDONLY, 0.0);
    assert_eq!(read_at(&mut fs, reader, 5.0, NO_POSITION), "hello");
    assert_eq!(read_at(&mut fs, reader, 100.0, NO_POSITION), " world");
    assert_eq!(read_at(&mut fs, reader, 10.0, NO_POSITION), "");
    close(&mut fs, reader);
}

#[test]
fn leaves_the_offset_alone_for_positioned_reads_and_writes() {
    let mut fs = setup();
    put(&mut fs, "/f", "abcdef");
    let file = open(&mut fs, "/f", O_RDWR, 0.0);
    assert_eq!(read_at(&mut fs, file, 2.0, 3.0), "de");
    assert_eq!(read_at(&mut fs, file, 2.0, NO_POSITION), "ab");
    write(&mut fs, file, "XY", 4.0).unwrap();
    assert_eq!(read_at(&mut fs, file, 10.0, NO_POSITION), "cdXY");
    assert_eq!(read_at(&mut fs, file, 2.5, 1.5), "bcd");
    assert_eq!(read_at(&mut fs, file, f64::NAN, 0.0), "");
    assert_eq!(read_at(&mut fs, file, f64::INFINITY, 4.0), "XY");
    // A negative position counts from the end, as typed-array slicing does.
    assert_eq!(read_at(&mut fs, file, 1.0, -1.0), "");
    assert_eq!(read_at(&mut fs, file, 10.0, -2.0), "XY");
    // `slice(-3, Math.min(6, -3 + 7))`: from 3 to 4.
    assert_eq!(read_at(&mut fs, file, 7.0, -3.0), "d");
    assert_eq!(read_at(&mut fs, file, f64::INFINITY, f64::NEG_INFINITY), "");
    assert_eq!(read_at(&mut fs, file, 2.0, NO_POSITION), "");
    assert_eq!(
        failure(write(&mut fs, file, "x", 1.5)),
        (Einval, Syscall::Write, PATH_NONE)
    );
    close(&mut fs, file);
}

#[test]
fn counts_a_negative_read_position_from_the_end_of_the_buffer() {
    let mut fs = setup();
    let file = open(&mut fs, "/f", O_RDWR | O_CREAT, 0o644 as f64);
    write(&mut fs, file, "abc", NO_POSITION).unwrap();
    // The buffer doubles to 6 bytes for the fourth: vfs.ts slices that buffer,
    // so -1 is past the file's end and -3 is the "d".
    write(&mut fs, file, "d", NO_POSITION).unwrap();
    assert_eq!(read_at(&mut fs, file, 10.0, -1.0), "");
    assert_eq!(read_at(&mut fs, file, 10.0, -3.0), "d");
    close(&mut fs, file);
}

#[test]
fn zero_fills_gaps_and_regrown_regions() {
    let mut fs = setup();
    let file = open(&mut fs, "/sparse", O_RDWR | O_CREAT, 0o644 as f64);
    write(&mut fs, file, "a", 0.0).unwrap();
    write(&mut fs, file, "b", 5.0).unwrap();
    close(&mut fs, file);
    assert_eq!(read_bytes(&mut fs, "/sparse"), [97, 0, 0, 0, 0, 98]);

    put(&mut fs, "/f", "abcdef");
    fs.truncate(b"/f", 2.0).unwrap();
    let file = open(&mut fs, "/f", O_RDWR, 0.0);
    write(&mut fs, file, "z", 5.0).unwrap();
    close(&mut fs, file);
    assert_eq!(read_bytes(&mut fs, "/f"), [97, 98, 0, 0, 0, 122]);
}

#[test]
fn always_writes_at_the_end_with_o_append() {
    let mut fs = setup();
    put(&mut fs, "/f", "abc");
    let file = open(&mut fs, "/f", O_WRONLY | O_APPEND, 0.0);
    write(&mut fs, file, "d", 0.0).unwrap();
    write(&mut fs, file, "e", NO_POSITION).unwrap();
    close(&mut fs, file);
    assert_eq!(read(&mut fs, "/f"), "abcde");
}

#[test]
fn grows_by_appending_many_small_writes() {
    let mut fs = setup();
    let file = open(&mut fs, "/log", O_WRONLY | O_CREAT | O_APPEND, 0o644 as f64);
    for _ in 0..10000 {
        fs.handle_write(file, 1, NO_POSITION)
            .unwrap()
            .copy_from_slice(b"x");
    }
    close(&mut fs, file);
    assert_eq!(stat(&fs, "/log", true)[SIZE], 10000.0);
    assert_eq!(fs.totals().1, 10000);
}

#[test]
fn handles_the_open_flags() {
    let mut fs = setup();
    put(&mut fs, "/f", "abc");
    let file = open(&mut fs, "/f", O_WRONLY | O_TRUNC, 0.0);
    close(&mut fs, file);
    assert_eq!(read(&mut fs, "/f"), "");

    assert_eq!(
        failure(fs.open(b"/f", O_WRONLY | O_CREAT | O_EXCL, 0.0)),
        (Eexist, Syscall::Open, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.open(b"/missing", O_RDONLY, 0.0)),
        (Enoent, Syscall::Open, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.open(b"/f", O_RDONLY | O_DIRECTORY, 0.0)),
        (Enotdir, Syscall::Open, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.open(b"/new", O_RDONLY | O_CREAT | O_DIRECTORY, 0.0)),
        (Einval, Syscall::Open, PATH_FIRST)
    );
    symlink(&mut fs, "/f", "/link");
    assert_eq!(
        failure(fs.open(b"/link", O_RDONLY | O_NOFOLLOW, 0.0)),
        (Eloop, Syscall::Open, PATH_FIRST)
    );
    checked(&fs, ());
}

#[test]
fn treats_dangling_symlinks_by_o_excl() {
    let mut fs = setup();
    symlink(&mut fs, "/nowhere", "/link");
    assert_eq!(
        failure(fs.open(b"/link", O_WRONLY | O_CREAT | O_EXCL, 0.0)).0,
        Eexist
    );
    assert!(!exists(&fs, "/nowhere"));
    symlink(&mut fs, "/target", "/other");
    put(&mut fs, "/other", "via link");
    assert_eq!(read(&mut fs, "/target"), "via link");
}

#[test]
fn opens_a_directory_read_only() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    let dir = open(&mut fs, "/d", O_RDONLY | O_DIRECTORY, 0.0);
    assert_eq!(kind_of(&fs.handle_stat(dir).unwrap()), S_IFDIR);
    assert_eq!(
        failure(fs.handle_read(dir, 1.0, NO_POSITION)),
        (Eisdir, Syscall::Read, PATH_NONE)
    );
    assert_eq!(
        failure(write(&mut fs, dir, "x", NO_POSITION)),
        (Ebadf, Syscall::Write, PATH_NONE)
    );
    assert_eq!(
        failure(fs.handle_truncate(dir, 0.0)),
        (Einval, Syscall::Ftruncate, PATH_NONE)
    );
    fs.handle_chmod(dir, 0o700).unwrap();
    assert_eq!(stat(&fs, "/d", true)[MODE] as u32, S_IFDIR | 0o700);
    close(&mut fs, dir);
    assert_eq!(
        failure(fs.open(b"/d", O_RDWR, 0.0)),
        (Eisdir, Syscall::Open, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.open(b"/d", O_RDONLY | O_CREAT, 0.0)),
        (Eisdir, Syscall::Open, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.open(b"/d", O_RDONLY | O_TRUNC, 0.0)),
        (Eisdir, Syscall::Open, PATH_FIRST)
    );
}

#[test]
fn keeps_a_removed_directory_usable_while_it_is_open() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    let dir = open(&mut fs, "/d", O_RDONLY, 0.0);
    fs.rmdir(b"/d").unwrap();
    checked(&fs, ());
    assert_eq!(fs.totals().0, 1);
    assert_eq!(fs.handle_stat(dir).unwrap()[NLINK], 0.0);
    fs.watching = true;
    fs.handle_utimes(dir, 1.0, 2.0).unwrap();
    assert_eq!(take_events(&mut fs), vec![]);
    close(&mut fs, dir);
    mkdir(&mut fs, "/e");
    assert_eq!(fs.totals().0, 2);
}

#[test]
fn raises_ebadf_after_close_and_reuses_the_number() {
    let mut fs = setup();
    let file = open(&mut fs, "/f", O_RDWR | O_CREAT, 0o644 as f64);
    close(&mut fs, file);
    assert_eq!(
        failure(fs.handle_read(file, 1.0, NO_POSITION)),
        (Ebadf, Syscall::Read, PATH_NONE)
    );
    assert_eq!(
        failure(write(&mut fs, file, "x", NO_POSITION)),
        (Ebadf, Syscall::Write, PATH_NONE)
    );
    assert_eq!(
        failure(fs.handle_stat(file)),
        (Ebadf, Syscall::Fstat, PATH_NONE)
    );
    assert_eq!(
        failure(fs.handle_truncate(file, 0.0)),
        (Ebadf, Syscall::Ftruncate, PATH_NONE)
    );
    assert_eq!(
        failure(fs.handle_chmod(file, 0)),
        (Ebadf, Syscall::Fchmod, PATH_NONE)
    );
    assert_eq!(
        failure(fs.handle_utimes(file, 0.0, 0.0)),
        (Ebadf, Syscall::Futime, PATH_NONE)
    );
    assert_eq!(
        failure(fs.handle_close(file)),
        (Ebadf, Syscall::Close, PATH_NONE)
    );
    assert_eq!(
        failure(fs.handle_close(u32::MAX)),
        (Ebadf, Syscall::Close, PATH_NONE)
    );
    assert_eq!(open(&mut fs, "/f", O_RDONLY, 0.0), file);
}

#[test]
fn raises_ebadf_for_the_wrong_access_mode() {
    let mut fs = setup();
    put(&mut fs, "/f", "abc");
    let reader = open(&mut fs, "/f", O_RDONLY, 0.0);
    assert_eq!(
        failure(write(&mut fs, reader, "x", NO_POSITION)),
        (Ebadf, Syscall::Write, PATH_NONE)
    );
    assert_eq!(
        failure(fs.handle_truncate(reader, 0.0)),
        (Einval, Syscall::Ftruncate, PATH_NONE)
    );
    close(&mut fs, reader);
    let writer = open(&mut fs, "/f", O_WRONLY, 0.0);
    assert_eq!(
        failure(fs.handle_read(writer, 1.0, NO_POSITION)),
        (Ebadf, Syscall::Read, PATH_NONE)
    );
    assert_eq!(failure(fs.handle_truncate(writer, -1.0)).0, Einval);
    assert_eq!(failure(fs.handle_truncate(writer, f64::NAN)).0, Einval);
    assert_eq!(
        failure(fs.handle_truncate(writer, MAX_FILE_SIZE + 1.0)),
        (Efbig, Syscall::Ftruncate, PATH_NONE)
    );
    assert_eq!(
        failure(write(&mut fs, writer, "x", MAX_FILE_SIZE)),
        (Efbig, Syscall::Write, PATH_NONE)
    );
    close(&mut fs, writer);
}

#[test]
fn keeps_an_unlinked_file_until_it_is_closed() {
    let mut fs = setup();
    put(&mut fs, "/f", "still here");
    let before = fs.totals();
    let file = open(&mut fs, "/f", O_RDWR, 0.0);
    fs.unlink(b"/f").unwrap();
    checked(&fs, ());
    assert!(!exists(&fs, "/f"));
    assert_eq!(read_at(&mut fs, file, 100.0, 0.0), "still here");
    write(&mut fs, file, "!", NO_POSITION).unwrap();
    assert_eq!(fs.handle_stat(file).unwrap()[NLINK], 0.0);
    assert_eq!(fs.totals().0, before.0);
    close(&mut fs, file);
    assert_eq!(fs.totals(), (before.0 - 1, before.1 - 10));
}

#[test]
fn keeps_an_open_file_working_after_a_rename() {
    let mut fs = setup();
    put(&mut fs, "/f", "abc");
    let file = open(&mut fs, "/f", O_RDWR, 0.0);
    fs.rename(b"/f", b"/g").unwrap();
    write(&mut fs, file, "Z", 0.0).unwrap();
    close(&mut fs, file);
    assert_eq!(read(&mut fs, "/g"), "Zbc");
}

#[test]
fn supports_fchmod_futimes_and_ftruncate() {
    let mut fs = setup();
    put(&mut fs, "/f", "abcdef");
    let file = open(&mut fs, "/f", O_RDWR, 0.0);
    fs.handle_chmod(file, 0o600).unwrap();
    fs.handle_utimes(file, 5.0, 6.0).unwrap();
    tick(&mut fs, 1.0);
    fs.handle_truncate(file, 3.7).unwrap();
    let stat = fs.handle_stat(file).unwrap();
    assert_eq!(stat[MODE] as u32, S_IFREG | 0o600);
    assert_eq!(stat[ATIME], 5.0);
    assert_eq!(stat[MTIME], 1001.0);
    assert_eq!(stat[SIZE], 3.0);
    close(&mut fs, file);
}

// ---- timestamps ----

#[test]
fn sets_all_four_times_at_creation() {
    let mut fs = setup();
    put(&mut fs, "/f", "");
    assert_eq!(&stat(&fs, "/f", true)[ATIME..], &[1000.0; 4]);
}

#[test]
fn updates_times_as_vfs_ts_does() {
    let mut fs = setup();
    put(&mut fs, "/f", "a");
    let t = tick(&mut fs, 10.0);
    put(&mut fs, "/f", "b");
    let s = stat(&fs, "/f", true);
    assert_eq!((s[MTIME], s[CTIME], s[BIRTHTIME]), (t, t, 1000.0));

    let t = tick(&mut fs, 10.0);
    fs.chmod(b"/f", 0o600, true).unwrap();
    let s = stat(&fs, "/f", true);
    assert_eq!(
        (s[CTIME], s[MTIME], s[MODE] as u32),
        (t, t - 10.0, S_IFREG | 0o600)
    );

    let t = tick(&mut fs, 5.0);
    fs.utimes(b"/f", 111.0, 222.0, true).unwrap();
    let s = stat(&fs, "/f", true);
    assert_eq!((s[ATIME], s[MTIME], s[CTIME]), (111.0, 222.0, t));

    let t = tick(&mut fs, 1.0);
    fs.read_file(b"/f").unwrap();
    assert_eq!(stat(&fs, "/f", true)[ATIME], t);
}

#[test]
fn updates_a_directory_when_its_entries_change() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    let t = tick(&mut fs, 1.0);
    put(&mut fs, "/d/f", "");
    assert_eq!(stat(&fs, "/d", true)[MTIME], t);
    let t = tick(&mut fs, 1.0);
    fs.rename(b"/d/f", b"/d/g").unwrap();
    assert_eq!(stat(&fs, "/d", true)[CTIME], t);
    let t = tick(&mut fs, 1.0);
    fs.unlink(b"/d/g").unwrap();
    assert_eq!(stat(&fs, "/d", true)[MTIME], t);
}

#[test]
fn sets_a_symlinks_own_times_when_not_following() {
    let mut fs = setup();
    put(&mut fs, "/f", "");
    symlink(&mut fs, "/f", "/link");
    fs.utimes(b"/link", 1.0, 2.0, false).unwrap();
    assert_eq!(stat(&fs, "/link", false)[MTIME], 2.0);
    assert_eq!(stat(&fs, "/f", true)[MTIME], 1000.0);
    assert_eq!(
        failure(fs.utimes(b"/nope", 1.0, 2.0, true)),
        (Enoent, Syscall::Utime, PATH_FIRST)
    );
}

#[test]
fn reads_the_clock_where_vfs_ts_does() {
    let mut fs = setup();
    assert_eq!(clock_reads(&mut fs, |fs| put(fs, "/f", "abc")), 2);
    assert_eq!(clock_reads(&mut fs, |fs| put(fs, "/f", "de")), 2);
    assert_eq!(clock_reads(&mut fs, |fs| put(fs, "/e", "")), 1);
    assert_eq!(clock_reads(&mut fs, |fs| put(fs, "/e", "")), 0);
    assert_eq!(
        clock_reads(&mut fs, |fs| {
            fs.stat(b"/f", true).unwrap();
        }),
        0
    );
    assert_eq!(
        clock_reads(&mut fs, |fs| {
            fs.read_file(b"/f").unwrap();
        }),
        1
    );
    assert_eq!(
        clock_reads(&mut fs, |fs| {
            mkdir_p(fs, "/a/b/c");
        }),
        3
    );
    assert_eq!(
        clock_reads(&mut fs, |fs| fs.rename(b"/e", b"/g").unwrap()),
        1
    );
    assert_eq!(
        clock_reads(&mut fs, |fs| fs.rename(b"/g", b"/f").unwrap()),
        2
    );
    assert_eq!(
        clock_reads(&mut fs, |fs| fs.copy_file(b"/f", b"/h", 0).unwrap()),
        2
    );
    assert_eq!(
        clock_reads(&mut fs, |fs| fs.copy_file(b"/f", b"/h", 0).unwrap()),
        3
    );
    assert_eq!(clock_reads(&mut fs, |fs| fs.link(b"/h", b"/i").unwrap()), 1);
    assert_eq!(
        clock_reads(&mut fs, |fs| fs.truncate(b"/h", 9.0).unwrap()),
        1
    );
    assert_eq!(
        clock_reads(&mut fs, |fs| fs.rm(b"/a", true, false).unwrap()),
        3
    );
    let file = open(&mut fs, "/f", O_RDWR, 0.0);
    assert_eq!(
        clock_reads(&mut fs, |fs| write(fs, file, "", NO_POSITION).unwrap()),
        0
    );
    assert_eq!(
        clock_reads(&mut fs, |fs| {
            read_at(fs, file, 1.0, NO_POSITION);
        }),
        1
    );
    assert_eq!(clock_reads(&mut fs, |fs| close(fs, file)), 0);
    checked(&fs, ());
}

// ---- directories ----

#[test]
fn creates_and_lists_directories() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    put(&mut fs, "/d/b", "");
    mkdir(&mut fs, "/d/c");
    symlink(&mut fs, "b", "/d/a");
    assert_eq!(
        listing(&mut fs, "/d"),
        vec![
            ("a".into(), KIND_SYMLINK),
            ("b".into(), KIND_FILE),
            ("c".into(), KIND_DIR)
        ]
    );
    fs.mkdir(b"/e", false, 0o700 as f64).unwrap();
    assert_eq!(stat(&fs, "/d", true)[MODE] as u32, S_IFDIR | 0o755);
    assert_eq!(stat(&fs, "/e", true)[MODE] as u32, S_IFDIR | 0o700);
}

#[test]
fn counts_subdirectories_in_nlink() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    assert_eq!(stat(&fs, "/d", true)[NLINK], 2.0);
    mkdir(&mut fs, "/d/a");
    mkdir(&mut fs, "/d/b");
    assert_eq!(stat(&fs, "/d", true)[NLINK], 4.0);
    fs.rmdir(b"/d/a").unwrap();
    assert_eq!(stat(&fs, "/d", true)[NLINK], 3.0);
    checked(&fs, ());
}

#[test]
fn raises_the_errors_of_mkdir() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    assert_eq!(
        failure(fs.mkdir(b"/d", false, 0.0)),
        (Eexist, Syscall::Mkdir, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.mkdir(b"/", false, 0.0)),
        (Eexist, Syscall::Mkdir, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.mkdir(b"/a/b", false, 0.0)),
        (Enoent, Syscall::Mkdir, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.mkdir(b"", true, 0.0)),
        (Enoent, Syscall::Mkdir, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.mkdir(b"a", true, 0.0)),
        (Einval, Syscall::Mkdir, PATH_FIRST)
    );
    checked(&fs, ());
}

#[test]
fn makes_parents_with_mkdir_p() {
    let mut fs = setup();
    mkdir(&mut fs, "/a");
    assert_eq!(mkdir_p(&mut fs, "/a/b/c/d").as_deref(), Some("/a/b"));
    assert_eq!(kind_of(&stat(&fs, "/a/b/c/d", true)), S_IFDIR);
    assert_eq!(mkdir_p(&mut fs, "/a/b"), None);
    assert_eq!(mkdir_p(&mut fs, "/"), None);
    assert_eq!(mkdir_p(&mut fs, "/e/f/"), Some("/e".into()));
    fs.mkdir(b"/g/", false, 0.0).unwrap();
    assert!(exists(&fs, "/e/f") && exists(&fs, "/g"));
}

#[test]
fn follows_symlinks_in_mkdir_p() {
    let mut fs = setup();
    mkdir(&mut fs, "/real");
    symlink(&mut fs, "/real", "/link");
    assert_eq!(mkdir_p(&mut fs, "/link/x/y").as_deref(), Some("/link/x"));
    assert!(exists(&fs, "/real/x/y"));
}

#[test]
fn raises_enotdir_through_a_file_and_eexist_at_one_in_mkdir_p() {
    let mut fs = setup();
    put(&mut fs, "/f", "");
    assert_eq!(
        failure(fs.mkdir(b"/f/x/y", true, 0.0)),
        (Enotdir, Syscall::Mkdir, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.mkdir(b"/f", true, 0.0)),
        (Eexist, Syscall::Mkdir, PATH_FIRST)
    );
    symlink(&mut fs, "/f", "/lf");
    assert_eq!(failure(fs.mkdir(b"/lf/x", true, 0.0)).0, Enotdir);
    checked(&fs, ());
}

#[test]
fn makes_and_removes_a_deep_tree_without_recursion() {
    let mut fs = setup();
    let depth = 2000;
    let path: String = (0..depth).map(|_| "/d").collect();
    assert_eq!(mkdir_p(&mut fs, &path).as_deref(), Some("/d"));
    put(&mut fs, &format!("{path}/f"), "x");
    assert_eq!(fs.realpath(path.as_bytes()).unwrap(), path.as_bytes());
    assert_eq!(fs.totals().0, depth + 2);
    fs.rename(b"/d", b"/e").unwrap();
    assert_eq!(
        failure(fs.rename(b"/e", format!("/e{}", &path[2..]).as_bytes())).0,
        Einval
    );
    fs.rm(b"/e", true, false).unwrap();
    assert_eq!(checked(&fs, fs.totals()), (1, 0));
}

#[test]
fn raises_the_errors_of_rmdir() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    put(&mut fs, "/d/f", "");
    assert_eq!(
        failure(fs.rmdir(b"/d")),
        (Enotempty, Syscall::Rmdir, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.rmdir(b"/d/f")),
        (Enotdir, Syscall::Rmdir, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.rmdir(b"/nope")),
        (Enoent, Syscall::Rmdir, PATH_FIRST)
    );
    assert_eq!(failure(fs.rmdir(b"/")), (Ebusy, Syscall::Rmdir, PATH_FIRST));
    assert_eq!(
        failure(fs.rmdir(b"/d/..")),
        (Ebusy, Syscall::Rmdir, PATH_FIRST)
    );
    // `/d/.` names the entry `d`; only a final `..` ends at no entry.
    assert_eq!(
        failure(fs.rmdir(b"/d/.")),
        (Enotempty, Syscall::Rmdir, PATH_FIRST)
    );
    mkdir(&mut fs, "/d/e");
    assert_eq!(
        failure(fs.rmdir(b"/d/e/..")),
        (Einval, Syscall::Rmdir, PATH_FIRST)
    );
    fs.rmdir(b"/d/e").unwrap();
    symlink(&mut fs, "/d", "/link");
    assert_eq!(
        failure(fs.rmdir(b"/link")),
        (Enotdir, Syscall::Rmdir, PATH_FIRST)
    );
    fs.unlink(b"/d/f").unwrap();
    fs.rmdir(b"/d").unwrap();
    assert!(!exists(&fs, "/d"));
    checked(&fs, ());
}

#[test]
fn raises_the_errors_of_readdir_and_reads_through_a_link() {
    let mut fs = setup();
    put(&mut fs, "/f", "");
    assert_eq!(
        failure(fs.readdir(b"/f")),
        (Enotdir, Syscall::Scandir, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.readdir(b"/nope")),
        (Enoent, Syscall::Scandir, PATH_FIRST)
    );
    mkdir(&mut fs, "/d");
    put(&mut fs, "/d/f", "");
    symlink(&mut fs, "/d", "/link");
    assert_eq!(listing(&mut fs, "/link"), vec![("f".into(), KIND_FILE)]);
}

// ---- unlink and rm ----

#[test]
fn unlinks_files_and_links() {
    let mut fs = setup();
    put(&mut fs, "/f", "x");
    symlink(&mut fs, "/f", "/link");
    fs.unlink(b"/link").unwrap();
    assert!(!exists(&fs, "/link"));
    assert_eq!(read(&mut fs, "/f"), "x");
    fs.unlink(b"/f").unwrap();
    assert!(!exists(&fs, "/f"));
    mkdir(&mut fs, "/d");
    assert_eq!(
        failure(fs.unlink(b"/d")),
        (Eisdir, Syscall::Unlink, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.unlink(b"/d/.")),
        (Eisdir, Syscall::Unlink, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.unlink(b"/nope")),
        (Enoent, Syscall::Unlink, PATH_FIRST)
    );
    checked(&fs, ());
}

#[test]
fn removes_with_rm() {
    let mut fs = setup();
    put(&mut fs, "/f", "");
    fs.rm(b"/f", false, false).unwrap();
    assert!(!exists(&fs, "/f"));
    assert_eq!(
        failure(fs.rm(b"/nope", false, false)),
        (Enoent, Syscall::Rm, PATH_FIRST)
    );
    fs.rm(b"/nope", false, true).unwrap();
    fs.rm(b"/no/such/deep", true, true).unwrap();
    assert_eq!(
        failure(fs.rm(b"rel", true, true)),
        (Einval, Syscall::Rm, PATH_FIRST)
    );
    mkdir(&mut fs, "/d");
    assert_eq!(
        failure(fs.rm(b"/d", false, false)),
        (Eisdir, Syscall::Rm, PATH_FIRST)
    );
    mkdir(&mut fs, "/d/e");
    assert_eq!(
        failure(fs.rm(b"/d/e/..", true, false)),
        (Einval, Syscall::Rm, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.rm(b"/", true, true)),
        (Ebusy, Syscall::Rm, PATH_FIRST)
    );
    checked(&fs, ());
}

#[test]
fn removes_a_tree_and_frees_its_inodes() {
    let mut fs = setup();
    let before = fs.totals();
    mkdir_p(&mut fs, "/d/a/b");
    put(&mut fs, "/d/a/b/f", "12345");
    put(&mut fs, "/d/g", "1");
    symlink(&mut fs, "/d/g", "/d/a/link");
    fs.link(b"/d/g", b"/d/a/hard").unwrap();
    fs.rm(b"/d", true, false).unwrap();
    assert!(!exists(&fs, "/d"));
    assert_eq!(checked(&fs, fs.totals()), before);
}

#[test]
fn keeps_an_open_file_of_a_removed_tree() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    put(&mut fs, "/d/f", "data");
    let file = open(&mut fs, "/d/f", O_RDONLY, 0.0);
    fs.rm(b"/d", true, false).unwrap();
    checked(&fs, ());
    assert_eq!(read_at(&mut fs, file, 10.0, 0.0), "data");
    close(&mut fs, file);
    assert_eq!(fs.totals(), (1, 0));
}

#[test]
fn removes_a_symlink_to_a_directory_without_touching_it() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    put(&mut fs, "/d/f", "");
    symlink(&mut fs, "/d", "/link");
    fs.rm(b"/link", true, false).unwrap();
    assert!(exists(&fs, "/d/f"));
}

// ---- rename ----

#[test]
fn moves_and_replaces_files() {
    let mut fs = setup();
    put(&mut fs, "/a", "x");
    mkdir(&mut fs, "/d");
    fs.rename(b"/a", b"/d/b").unwrap();
    assert!(!exists(&fs, "/a"));
    assert_eq!(read(&mut fs, "/d/b"), "x");

    put(&mut fs, "/n", "new");
    put(&mut fs, "/o", "old");
    let before = fs.totals();
    fs.rename(b"/n", b"/o").unwrap();
    assert_eq!(read(&mut fs, "/o"), "new");
    assert!(!exists(&fs, "/n"));
    assert_eq!(fs.totals(), (before.0 - 1, before.1 - 3));
}

#[test]
fn moves_a_directory_with_its_contents() {
    let mut fs = setup();
    mkdir_p(&mut fs, "/a/b");
    put(&mut fs, "/a/b/f", "x");
    fs.rename(b"/a", b"/z").unwrap();
    assert_eq!(read(&mut fs, "/z/b/f"), "x");
    assert_eq!(fs.realpath(b"/z/b/f").unwrap(), b"/z/b/f");

    mkdir(&mut fs, "/e");
    fs.rename(b"/z", b"/e").unwrap();
    assert!(exists(&fs, "/e/b/f"));
    checked(&fs, ());
}

#[test]
fn raises_the_errors_of_rename() {
    let mut fs = setup();
    mkdir(&mut fs, "/a");
    mkdir(&mut fs, "/b");
    put(&mut fs, "/b/f", "");
    put(&mut fs, "/file", "");
    assert_eq!(
        failure(fs.rename(b"/a", b"/b")),
        (Enotempty, Syscall::Rename, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.rename(b"/file", b"/a")),
        (Eisdir, Syscall::Rename, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.rename(b"/a", b"/file")),
        (Enotdir, Syscall::Rename, PATH_BOTH)
    );
    mkdir(&mut fs, "/a/sub");
    assert_eq!(
        failure(fs.rename(b"/a", b"/a/sub/c")),
        (Einval, Syscall::Rename, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.rename(b"/a", b"/a/c")),
        (Einval, Syscall::Rename, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.rename(b"/nope", b"/x")),
        (Enoent, Syscall::Rename, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.rename(b"/file", b"/no/x")),
        (Enoent, Syscall::Rename, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.rename(b"/", b"/x")),
        (Ebusy, Syscall::Rename, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.rename(b"/file", b"/")),
        (Ebusy, Syscall::Rename, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.rename(b"/a/sub/..", b"/x")),
        (Einval, Syscall::Rename, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.rename(b"/file", b"/a/sub/..")),
        (Einval, Syscall::Rename, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.rename(b"/file", b"/a/.")),
        (Eisdir, Syscall::Rename, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.rename(b"rel", b"/x")),
        (Einval, Syscall::Rename, PATH_BOTH)
    );
    checked(&fs, ());
}

#[test]
fn does_nothing_renaming_onto_itself_or_a_hard_link() {
    let mut fs = setup();
    put(&mut fs, "/a", "x");
    assert_eq!(
        clock_reads(&mut fs, |fs| fs.rename(b"/a", b"/a").unwrap()),
        0
    );
    fs.link(b"/a", b"/b").unwrap();
    fs.rename(b"/a", b"/b").unwrap();
    assert_eq!(read(&mut fs, "/a"), "x");
    assert_eq!(read(&mut fs, "/b"), "x");
}

#[test]
fn moves_a_symlink_itself() {
    let mut fs = setup();
    put(&mut fs, "/f", "x");
    symlink(&mut fs, "/f", "/link");
    fs.rename(b"/link", b"/moved").unwrap();
    assert_eq!(fs.readlink(b"/moved").unwrap(), b"/f");
    assert!(exists(&fs, "/f"));
}

#[test]
fn updates_nlink_of_both_parents() {
    let mut fs = setup();
    mkdir_p(&mut fs, "/a/sub");
    mkdir(&mut fs, "/b");
    fs.rename(b"/a/sub", b"/b/sub").unwrap();
    assert_eq!(stat(&fs, "/a", true)[NLINK], 2.0);
    assert_eq!(stat(&fs, "/b", true)[NLINK], 3.0);
    checked(&fs, ());
}

#[test]
fn moves_the_primary_link_only_when_renaming_it() {
    let mut fs = setup();
    put(&mut fs, "/a", "x");
    fs.link(b"/a", b"/b").unwrap();
    let file = open(&mut fs, "/a", O_WRONLY, 0.0);
    fs.watching = true;
    fs.rename(b"/b", b"/c").unwrap();
    write(&mut fs, file, "1", NO_POSITION).unwrap();
    fs.rename(b"/a", b"/d").unwrap();
    write(&mut fs, file, "2", NO_POSITION).unwrap();
    assert_eq!(
        take_events(&mut fs),
        vec![
            renamed("/b"),
            renamed("/c"),
            changed("/a"),
            renamed("/a"),
            renamed("/d"),
            changed("/d")
        ]
    );
    close(&mut fs, file);
}

// ---- hard links ----

#[test]
fn shares_data_and_counts_links() {
    let mut fs = setup();
    put(&mut fs, "/a", "x");
    fs.link(b"/a", b"/b").unwrap();
    assert_eq!(stat(&fs, "/a", true)[NLINK], 2.0);
    assert_eq!(stat(&fs, "/b", true)[INO], stat(&fs, "/a", true)[INO]);
    put(&mut fs, "/b", "changed");
    assert_eq!(read(&mut fs, "/a"), "changed");
    fs.unlink(b"/a").unwrap();
    assert_eq!(stat(&fs, "/b", true)[NLINK], 1.0);
    assert_eq!(read(&mut fs, "/b"), "changed");
}

#[test]
fn raises_the_errors_of_link() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    put(&mut fs, "/a", "");
    put(&mut fs, "/b", "");
    assert_eq!(
        failure(fs.link(b"/d", b"/e")),
        (Eperm, Syscall::Link, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.link(b"/a", b"/b")),
        (Eexist, Syscall::Link, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.link(b"/a", b"/d/.")),
        (Eexist, Syscall::Link, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.link(b"/nope", b"/c")),
        (Enoent, Syscall::Link, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.link(b"/a", b"/c/")),
        (Enoent, Syscall::Link, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.link(b"/a", b"/no/c")),
        (Enoent, Syscall::Link, PATH_BOTH)
    );
    checked(&fs, ());
}

#[test]
fn links_the_symlink_itself() {
    let mut fs = setup();
    put(&mut fs, "/f", "");
    symlink(&mut fs, "/f", "/link");
    fs.link(b"/link", b"/link2").unwrap();
    assert_eq!(fs.readlink(b"/link2").unwrap(), b"/f");
    assert_eq!(stat(&fs, "/link", false)[NLINK], 2.0);
    checked(&fs, ());
}

#[test]
fn reports_at_the_primary_link_and_adopts_a_new_one() {
    let mut fs = setup();
    put(&mut fs, "/a", "x");
    fs.link(b"/a", b"/b").unwrap();
    let file = open(&mut fs, "/b", O_WRONLY, 0.0);
    fs.watching = true;
    fs.unlink(b"/a").unwrap();
    // The primary link is gone: a change through the handle has no path.
    write(&mut fs, file, "y", NO_POSITION).unwrap();
    // A change by path reports the path it was made by.
    fs.chmod(b"/b", 0o600, true).unwrap();
    // A new link of a node with no primary link becomes it.
    fs.link(b"/b", b"/c").unwrap();
    write(&mut fs, file, "z", NO_POSITION).unwrap();
    assert_eq!(
        take_events(&mut fs),
        vec![renamed("/a"), changed("/b"), renamed("/c"), changed("/c")]
    );
    close(&mut fs, file);
}

// ---- symbolic links ----

#[test]
fn follows_absolute_and_relative_targets() {
    let mut fs = setup();
    mkdir_p(&mut fs, "/d/sub");
    put(&mut fs, "/d/sub/f", "x");
    symlink(&mut fs, "/d/sub/f", "/abs");
    symlink(&mut fs, "sub/f", "/d/rel");
    symlink(&mut fs, "../sub", "/d/sub/up");
    assert_eq!(read(&mut fs, "/abs"), "x");
    assert_eq!(read(&mut fs, "/d/rel"), "x");
    assert_eq!(read(&mut fs, "/d/sub/up/f"), "x");
}

#[test]
fn reports_the_link_or_its_target() {
    let mut fs = setup();
    put(&mut fs, "/f", "abc");
    symlink(&mut fs, "/f", "/link");
    let link = stat(&fs, "/link", false);
    assert_eq!(link[MODE] as u32, S_IFLNK | 0o777);
    assert_eq!(link[SIZE], 2.0);
    assert_eq!(kind_of(&stat(&fs, "/link", true)), S_IFREG);
}

#[test]
fn follows_chains_and_stops_loops() {
    let mut fs = setup();
    put(&mut fs, "/f", "x");
    symlink(&mut fs, "/f", "/l1");
    symlink(&mut fs, "/l1", "/l2");
    symlink(&mut fs, "l2", "/l3");
    assert_eq!(read(&mut fs, "/l3"), "x");
    assert_eq!(fs.realpath(b"/l3").unwrap(), b"/f");

    symlink(&mut fs, "/b", "/a");
    symlink(&mut fs, "/a", "/b");
    assert_eq!(
        failure(fs.stat(b"/a", true)),
        (Eloop, Syscall::Stat, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.read_file(b"/a/x")),
        (Eloop, Syscall::Open, PATH_FIRST)
    );
    assert_eq!(kind_of(&stat(&fs, "/a", false)), S_IFLNK);
}

#[test]
fn allows_exactly_40_links() {
    let mut fs = setup();
    put(&mut fs, "/f", "x");
    symlink(&mut fs, "/f", "/l0");
    for i in 1..=40 {
        symlink(&mut fs, &format!("/l{}", i - 1), &format!("/l{i}"));
    }
    assert_eq!(read(&mut fs, "/l39"), "x");
    assert_eq!(
        failure(fs.read_file(b"/l40")),
        (Eloop, Syscall::Open, PATH_FIRST)
    );
}

#[test]
fn handles_dangling_middle_and_trailing_links() {
    let mut fs = setup();
    symlink(&mut fs, "/nowhere", "/dangling");
    assert_eq!(
        failure(fs.stat(b"/dangling", true)),
        (Enoent, Syscall::Stat, PATH_FIRST)
    );
    assert!(!exists(&fs, "/dangling"));
    assert_eq!(kind_of(&stat(&fs, "/dangling", false)), S_IFLNK);

    mkdir(&mut fs, "/d");
    symlink(&mut fs, "/d", "/link");
    symlink(&mut fs, "x", "/d/inner");
    assert_eq!(kind_of(&stat(&fs, "/link/inner", false)), S_IFLNK);
    assert_eq!(kind_of(&stat(&fs, "/link/", false)), S_IFDIR);
    assert_eq!(kind_of(&stat(&fs, "/link/.", false)), S_IFDIR);
}

#[test]
fn resolves_dot_dot_after_a_link_physically() {
    let mut fs = setup();
    mkdir_p(&mut fs, "/x/y");
    put(&mut fs, "/x/marker", "m");
    symlink(&mut fs, "/x/y", "/link");
    assert_eq!(read(&mut fs, "/link/../marker"), "m");
    symlink(&mut fs, "y/..", "/x/back");
    assert_eq!(read(&mut fs, "/x/back/marker"), "m");
    assert_eq!(fs.realpath(b"/x/back").unwrap(), b"/x");
}

#[test]
fn raises_the_errors_of_symlink_and_readlink() {
    let mut fs = setup();
    put(&mut fs, "/f", "");
    assert_eq!(
        failure(fs.symlink(b"/t", b"/f")),
        (Eexist, Syscall::Symlink, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.symlink(b"/t", b"/")),
        (Eexist, Syscall::Symlink, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.symlink(b"", b"/e")),
        (Enoent, Syscall::Symlink, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.symlink(b"/t", b"/e/")),
        (Enoent, Syscall::Symlink, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.symlink(b"/t", b"/no/e")),
        (Enoent, Syscall::Symlink, PATH_BOTH)
    );
    symlink(&mut fs, "../some/./where", "/link");
    assert_eq!(fs.readlink(b"/link").unwrap(), b"../some/./where");
    assert_eq!(
        failure(fs.readlink(b"/f")),
        (Einval, Syscall::Readlink, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.readlink(b"/nope")),
        (Enoent, Syscall::Readlink, PATH_FIRST)
    );
    checked(&fs, ());
}

#[test]
fn chmods_through_links_but_not_a_links_own_mode() {
    let mut fs = setup();
    put(&mut fs, "/f", "");
    symlink(&mut fs, "/f", "/link");
    fs.chmod(b"/link", 0o700, true).unwrap();
    assert_eq!(stat(&fs, "/f", true)[MODE] as u32, S_IFREG | 0o700);
    assert_eq!(
        failure(fs.chmod(b"/link", 0o700, false)),
        (Enotsup, Syscall::Chmod, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.chmod(b"/nope", 0o700, true)),
        (Enoent, Syscall::Chmod, PATH_FIRST)
    );
    fs.chmod(b"/f", 0o17777, true).unwrap();
    assert_eq!(stat(&fs, "/f", true)[MODE] as u32, S_IFREG | 0o7777);
}

// ---- realpath ----

#[test]
fn resolves_real_paths() {
    let mut fs = setup();
    mkdir_p(&mut fs, "/a/b");
    symlink(&mut fs, "/a", "/link");
    assert_eq!(fs.realpath(b"/link/./b/../b//").unwrap(), b"/a/b");
    assert_eq!(fs.realpath(b"/").unwrap(), b"/");
    assert_eq!(fs.realpath(b"/a/..").unwrap(), b"/");
    assert_eq!(
        failure(fs.realpath(b"/nope")),
        (Enoent, Syscall::Realpath, PATH_FIRST)
    );
}

// ---- truncate ----

#[test]
fn truncates_by_path() {
    let mut fs = setup();
    put(&mut fs, "/f", "abcdef");
    fs.truncate(b"/f", 3.0).unwrap();
    assert_eq!(read(&mut fs, "/f"), "abc");
    fs.truncate(b"/f", 5.9).unwrap();
    assert_eq!(read_bytes(&mut fs, "/f"), [97, 98, 99, 0, 0]);
    assert_eq!(fs.totals().1, 5);
    mkdir(&mut fs, "/d");
    assert_eq!(
        failure(fs.truncate(b"/nope", 0.0)),
        (Enoent, Syscall::Open, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.truncate(b"/d", 0.0)),
        (Eisdir, Syscall::Open, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.truncate(b"/f", -1.0)),
        (Einval, Syscall::Ftruncate, PATH_NONE)
    );
    assert_eq!(
        failure(fs.truncate(b"/f", f64::NAN)),
        (Einval, Syscall::Ftruncate, PATH_NONE)
    );
    assert_eq!(
        failure(fs.truncate(b"/f", f64::INFINITY)),
        (Einval, Syscall::Ftruncate, PATH_NONE)
    );
    assert_eq!(
        failure(fs.truncate(b"/f", MAX_FILE_SIZE + 1.0)),
        (Efbig, Syscall::Ftruncate, PATH_NONE)
    );
    checked(&fs, ());
}

#[test]
fn fails_with_enospc_instead_of_aborting() {
    let mut data = vec![1u8, 2, 3];
    assert!(reserve(&mut Unlimited, &mut data, usize::MAX).is_err());
    assert_eq!(data, [1, 2, 3]);
    assert!(reserve(&mut Unlimited, &mut data, 5).is_ok());
    assert_eq!(data, [1, 2, 3, 0, 0, 0]);
    assert!(reserve(&mut Unlimited, &mut data, 13).is_ok());
    assert_eq!(data.len(), 13);
}

// ---- copyFile ----

#[test]
fn copies_data_and_mode() {
    let mut fs = setup();
    try_put(&mut fs, "/a", b"data", WRITE, 0o755 as f64).unwrap();
    fs.copy_file(b"/a", b"/b", 0).unwrap();
    assert_eq!(read(&mut fs, "/b"), "data");
    assert_eq!(stat(&fs, "/b", true)[MODE] as u32, S_IFREG | 0o755);
    assert_ne!(stat(&fs, "/b", true)[INO], stat(&fs, "/a", true)[INO]);
    put(&mut fs, "/empty", "");
    fs.copy_file(b"/empty", b"/empty2", 0).unwrap();
    assert_eq!(read(&mut fs, "/empty2"), "");
    assert_eq!(checked(&fs, fs.totals()), (5, 8));
}

#[test]
fn overwrites_unless_exclusive() {
    let mut fs = setup();
    put(&mut fs, "/a", "new");
    put(&mut fs, "/b", "older and longer");
    fs.copy_file(b"/a", b"/b", 0).unwrap();
    assert_eq!(read(&mut fs, "/b"), "new");
    assert_eq!(
        failure(fs.copy_file(b"/a", b"/b", COPYFILE_EXCL)),
        (Eexist, Syscall::Copyfile, PATH_BOTH)
    );
    put(&mut fs, "/small", "x");
    put(&mut fs, "/large", &"y".repeat(100));
    fs.copy_file(b"/large", b"/small", 0).unwrap();
    assert_eq!(read(&mut fs, "/small"), "y".repeat(100));
    assert_eq!(checked(&fs, fs.totals().1), 3 + 3 + 100 + 100);
}

#[test]
fn raises_the_errors_of_copy_file() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    put(&mut fs, "/a", "");
    assert_eq!(
        failure(fs.copy_file(b"/nope", b"/b", 0)),
        (Enoent, Syscall::Copyfile, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.copy_file(b"/d", b"/b", 0)),
        (Eisdir, Syscall::Copyfile, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.copy_file(b"/a", b"/d", 0)),
        (Eisdir, Syscall::Copyfile, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.copy_file(b"/a", b"/d/.", 0)),
        (Eisdir, Syscall::Copyfile, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.copy_file(b"/a", b"/new/", 0)),
        (Eisdir, Syscall::Copyfile, PATH_BOTH)
    );
    assert_eq!(
        failure(fs.copy_file(b"/a", b"/no/b", 0)),
        (Enoent, Syscall::Copyfile, PATH_BOTH)
    );
    checked(&fs, ());
}

#[test]
fn copies_through_links_and_onto_itself() {
    let mut fs = setup();
    put(&mut fs, "/a", "x");
    symlink(&mut fs, "/a", "/link");
    fs.copy_file(b"/link", b"/b", 0).unwrap();
    assert_eq!(kind_of(&stat(&fs, "/b", false)), S_IFREG);
    fs.copy_file(b"/a", b"/a", 0).unwrap();
    fs.copy_file(b"/a", b"/link", 0).unwrap();
    assert_eq!(read(&mut fs, "/a"), "x");
    // Exclusive does not follow the destination: the link itself exists.
    assert_eq!(
        failure(fs.copy_file(b"/a", b"/link", COPYFILE_EXCL)).0,
        Eexist
    );
}

// ---- access and mkdtemp ----

#[test]
fn checks_access() {
    let mut fs = setup();
    put(&mut fs, "/f", "");
    fs.access(b"/f", 0).unwrap();
    fs.access(b"/f", 4).unwrap();
    assert_eq!(
        failure(fs.access(b"/nope", 0)),
        (Enoent, Syscall::Access, PATH_FIRST)
    );
    assert_eq!(
        failure(fs.access(b"/f", X_OK)),
        (Eacces, Syscall::Access, PATH_FIRST)
    );
    fs.chmod(b"/f", 0o755, true).unwrap();
    fs.access(b"/f", X_OK).unwrap();
    mkdir(&mut fs, "/d");
    fs.access(b"/d", X_OK).unwrap();
}

#[test]
fn makes_one_temporary_directory_per_attempt() {
    let mut fs = setup();
    mkdir(&mut fs, "/tmp");
    assert!(fs.mkdtemp(b"/tmp/x-abcdef").unwrap());
    assert_eq!(
        stat(&fs, "/tmp/x-abcdef", true)[MODE] as u32,
        S_IFDIR | 0o700
    );
    assert!(!fs.mkdtemp(b"/tmp/x-abcdef").unwrap());
    assert_eq!(
        failure(fs.mkdtemp(b"/nope/x-abcdef")),
        (Enoent, Syscall::Mkdtemp, PATH_FIRST)
    );
    assert!(!fs.mkdtemp(b"/tmp/.").unwrap());
    checked(&fs, ());
}

// ---- watch ----

#[test]
fn finds_where_a_watch_really_is() {
    let mut fs = setup();
    mkdir(&mut fs, "/real");
    symlink(&mut fs, "/real", "/link");
    assert_eq!(fs.watch_path(b"/link").unwrap(), b"/real");
    assert_eq!(fs.watch_path(b"/link/.").unwrap(), b"/real");
    assert_eq!(fs.watch_path(b"/").unwrap(), b"/");
    assert_eq!(
        failure(fs.watch_path(b"/nope")),
        (Enoent, Syscall::Watch, PATH_FIRST)
    );
}

#[test]
fn logs_nothing_while_nothing_watches() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    put(&mut fs, "/d/f", "x");
    fs.rename(b"/d/f", b"/d/g").unwrap();
    fs.rm(b"/d", true, false).unwrap();
    assert!(fs.events().is_empty());
}

#[test]
fn logs_create_write_and_delete() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    fs.watching = true;
    put(&mut fs, "/d/f", "x");
    fs.unlink(b"/d/f").unwrap();
    assert_eq!(
        take_events(&mut fs),
        vec![renamed("/d/f"), changed("/d/f"), renamed("/d/f")]
    );
    put(&mut fs, "/d/sub", "");
    mkdir(&mut fs, "/d/dir");
    fs.rename(b"/d/sub", b"/d/dir/sub").unwrap();
    assert_eq!(
        take_events(&mut fs),
        vec![
            renamed("/d/sub"),
            renamed("/d/dir"),
            renamed("/d/sub"),
            renamed("/d/dir/sub")
        ]
    );
}

#[test]
fn logs_both_sides_of_a_rename_but_not_the_replaced_entry() {
    let mut fs = setup();
    put(&mut fs, "/a", "");
    put(&mut fs, "/b", "");
    fs.watching = true;
    fs.rename(b"/a", b"/b").unwrap();
    assert_eq!(take_events(&mut fs), vec![renamed("/a"), renamed("/b")]);
}

#[test]
fn logs_changes_to_a_file() {
    let mut fs = setup();
    put(&mut fs, "/f", "");
    fs.watching = true;
    put(&mut fs, "/f", "x");
    fs.chmod(b"/f", 0o600, true).unwrap();
    fs.utimes(b"/f", 1.0, 2.0, true).unwrap();
    fs.truncate(b"/f", 0.0).unwrap();
    // O_TRUNC of an empty file changes nothing, so it reports nothing.
    put(&mut fs, "/f", "");
    // O_TRUNC of a file with data reports, and so does the write after it.
    put(&mut fs, "/f", "ab");
    put(&mut fs, "/f", "c");
    assert_eq!(
        take_events(&mut fs),
        vec![
            changed("/f"),
            changed("/f"),
            changed("/f"),
            changed("/f"),
            changed("/f"),
            changed("/f"),
            changed("/f")
        ]
    );
    fs.copy_file(b"/f", b"/g", 0).unwrap();
    fs.copy_file(b"/f", b"/g", 0).unwrap();
    assert_eq!(take_events(&mut fs), vec![renamed("/g"), changed("/g")]);
}

#[test]
fn logs_changes_through_handles_and_at_directories() {
    let mut fs = setup();
    put(&mut fs, "/f", "");
    mkdir(&mut fs, "/d");
    fs.watching = true;
    let file = open(&mut fs, "/f", O_WRONLY, 0.0);
    write(&mut fs, file, "abc", NO_POSITION).unwrap();
    write(&mut fs, file, "", NO_POSITION).unwrap();
    fs.handle_truncate(file, 1.0).unwrap();
    fs.handle_chmod(file, 0o600).unwrap();
    fs.handle_utimes(file, 1.0, 1.0).unwrap();
    close(&mut fs, file);
    fs.chmod(b"/", 0o755, true).unwrap();
    fs.chmod(b"/d/.", 0o755, true).unwrap();
    fs.utimes(b"/d/..", 1.0, 1.0, true).unwrap();
    assert_eq!(
        take_events(&mut fs),
        vec![
            changed("/f"),
            changed("/f"),
            changed("/f"),
            changed("/f"),
            changed("/"),
            changed("/d"),
            changed("/")
        ]
    );
}

#[test]
fn logs_each_removed_entry_of_a_tree_in_vfs_order() {
    let mut fs = setup();
    mkdir_p(&mut fs, "/d/a");
    put(&mut fs, "/d/a/f", "");
    put(&mut fs, "/d/z", "");
    put(&mut fs, "/d/b", "");
    put(&mut fs, "/d/a/c", "");
    fs.watching = true;
    fs.rm(b"/d", true, false).unwrap();
    let paths: Vec<String> = take_events(&mut fs)
        .into_iter()
        .map(|(_, path)| path)
        .collect();
    assert_eq!(paths, ["/d/a/f", "/d/a/c", "/d/a", "/d/z", "/d/b", "/d"]);
}

#[test]
fn removes_a_tree_in_the_order_its_entries_were_made() {
    let mut fs = setup();
    mkdir(&mut fs, "/d");
    put(&mut fs, "/d/y", "");
    put(&mut fs, "/d/x", "");
    fs.rename(b"/d/y", b"/d/w").unwrap();
    fs.link(b"/d/x", b"/d/v").unwrap();
    fs.watching = true;
    fs.rm(b"/d", true, false).unwrap();
    let paths: Vec<String> = take_events(&mut fs)
        .into_iter()
        .map(|(_, path)| path)
        .collect();
    assert_eq!(paths, ["/d/x", "/d/w", "/d/v", "/d"]);
}

#[test]
fn stops_the_log_at_its_limit() {
    let mut fs = setup();
    let name = "n".repeat(60000);
    let path = format!("/{name}");
    put(&mut fs, &path, "");
    fs.watching = true;
    let fits = EVENT_LOG_LIMIT / (5 + path.len());
    for _ in 0..fits {
        fs.chmod(path.as_bytes(), 0o644, true).unwrap();
    }
    assert!(!fs.events_dropped());
    fs.chmod(path.as_bytes(), 0o644, true).unwrap();
    assert!(fs.events_dropped());
    assert_eq!(fs.events().len(), fits * (5 + path.len()));
    checked(&fs, ());
    fs.clear_events();
    assert!(fs.events().is_empty() && !fs.events_dropped());
}

// ---- totals and scale ----

#[test]
fn counts_inodes_and_bytes() {
    let mut fs = setup();
    assert_eq!(fs.totals(), (1, 0));
    put(&mut fs, "/a", "12345");
    mkdir(&mut fs, "/d");
    symlink(&mut fs, "/a", "/l");
    assert_eq!(fs.totals(), (4, 5));
    fs.unlink(b"/a").unwrap();
    assert_eq!(checked(&fs, fs.totals()), (3, 0));
}

#[test]
fn handles_many_small_files() {
    let mut fs = setup();
    for d in 0..10 {
        mkdir_p(&mut fs, &format!("/node_modules/pkg{d}/lib"));
        for f in 0..1000 {
            let path = format!("/node_modules/pkg{d}/lib/file{f}.js");
            fs.write_file(path.as_bytes(), WRITE, 0o644 as f64, 20)
                .unwrap()
                .copy_from_slice(b"module.exports = 1;\n");
        }
    }
    for d in 0..10 {
        assert!(exists(&fs, &format!("/node_modules/pkg{d}/lib/file999.js")));
        assert_eq!(
            fs.readdir(format!("/node_modules/pkg{d}/lib").as_bytes())
                .unwrap()
                .1,
            1000
        );
    }
    assert_eq!(checked(&fs, fs.totals()), (1 + 1 + 20 + 10_000, 200_000));
    fs.rm(b"/node_modules", true, false).unwrap();
    assert_eq!(checked(&fs, fs.totals()), (1, 0));
}

#[test]
fn stays_consistent_through_a_mixed_sequence() {
    let mut fs = setup();
    fs.watching = true;
    type Step = Box<dyn Fn(&mut TestFs)>;
    let steps: Vec<Step> = vec![
        Box::new(|fs| mkdir(fs, "/a")),
        Box::new(|fs| put(fs, "/a/f", "one")),
        Box::new(|fs| fs.link(b"/a/f", b"/g").unwrap()),
        Box::new(|fs| symlink(fs, "a", "/s")),
        Box::new(|fs| fs.rename(b"/s/f", b"/a/h").unwrap()),
        Box::new(|fs| fs.copy_file(b"/g", b"/s/copy", 0).unwrap()),
        Box::new(|fs| {
            let file = open(fs, "/g", O_RDWR | O_APPEND, 0.0);
            fs.unlink(b"/g").unwrap();
            fs.unlink(b"/a/h").unwrap();
            write(fs, file, "two", NO_POSITION).unwrap();
            close(fs, file);
        }),
        Box::new(|fs| {
            mkdir_p(fs, "/a/b/c");
        }),
        Box::new(|fs| fs.rename(b"/a/b", b"/b").unwrap()),
        Box::new(|fs| fs.rm(b"/a", true, false).unwrap()),
        Box::new(|fs| fs.rm(b"/b", true, false).unwrap()),
        Box::new(|fs| fs.unlink(b"/s").unwrap()),
    ];
    for step in &steps {
        step(&mut fs);
        checked(&fs, ());
    }
    assert_eq!(fs.totals(), (1, 0));
    assert!(!fs.events().is_empty());
}
