//! Sizes no ordinary test reaches: a tree deeper than any path can name, a
//! directory of hundreds of thousands of entries, a full event log.
//!
//! Nothing may recurse with the depth: the module's stack is 1 MiB, and
//! running out of it poisons the filesystem for every process. Removing must
//! need no memory, since removing is how memory is had again. And nothing may
//! take time that grows with the square of the size, since the lock every
//! process waits for is held meanwhile. The time limits here are many times
//! what the work takes, and far below what the quadratic versions took.
use super::*;
use crate::abi::Errno;
use crate::counting;
use std::cell::Cell;
use std::format;
use std::rc::Rc;
use std::string::String;
use std::time::{Duration, Instant};

const WRITE: u32 = O_WRONLY | O_CREAT | O_TRUNC;

struct Steady;

impl Clock for Steady {
    fn now(&mut self) -> f64 {
        1000.0
    }
}

/// Says no to everything while `none`.
#[derive(Clone, Default)]
struct Switch {
    none: Rc<Cell<bool>>,
}

impl Space for Switch {
    fn can_allocate(&mut self, _bytes: usize) -> bool {
        !self.none.get()
    }
}

type SwitchFs = Fs<Steady, Switch>;

fn setup() -> (SwitchFs, Switch) {
    let switch = Switch::default();
    (Fs::with_space(Steady, switch.clone()), switch)
}

fn put(fs: &mut SwitchFs, path: &str, content: &[u8]) {
    fs.write_file(path.as_bytes(), WRITE, 420.0, content.len())
        .unwrap()
        .copy_from_slice(content);
}

/// Runs `call` with no memory to be had at all: the space says no and every
/// allocation fails. Returns its result and how many allocations it tried.
fn starved<T>(switch: &Switch, call: impl FnOnce() -> T) -> (T, u64) {
    switch.none.set(true);
    counting::refuse(true);
    let before = counting::attempts();
    let result = call();
    let tried = counting::attempts() - before;
    counting::refuse(false);
    switch.none.set(false);
    (result, tried)
}

/// Runs `call` on a thread with the module's stack size.
fn on_the_modules_stack<T: Send + 'static>(call: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(call)
        .unwrap()
        .join()
        .expect("ran out of stack")
}

/// Makes `/r` and a chain of `depth` directories below it. A path names at
/// most 64 KiB, so the chain is built in pieces moved into place, and reached
/// through symbolic links (`/L1`, `/L2` ...). Returns a path to the bottom
/// and how many links it made.
fn build_deep(fs: &mut SwitchFs, depth: usize) -> (String, usize) {
    fs.mkdir(b"/r", false, f64::NAN).unwrap();
    let mut bottom = String::from("/r");
    let mut links = 0;
    let mut made = 1;
    while made < depth {
        let count = 1000.min(depth - made);
        let mut piece = String::from("/c");
        for _ in 1..count {
            piece.push_str("/x");
        }
        fs.mkdir(piece.as_bytes(), true, f64::NAN).unwrap();
        fs.rename(b"/c", format!("{bottom}/c").as_bytes()).unwrap();
        bottom.push_str(&piece);
        made += count;
        if bottom.len() > 60_000 {
            links += 1;
            let link = format!("/L{links}");
            fs.symlink(bottom.as_bytes(), link.as_bytes()).unwrap();
            bottom = link;
        }
    }
    (bottom, links)
}

/// Fills the event log to its limit.
fn fill_log(fs: &mut SwitchFs) {
    let filler = format!("/{}", "z".repeat(60_000));
    put(fs, &filler, b"");
    while fs.events().len() + filler.len() + 5 <= EVENT_LOG_LIMIT {
        fs.utimes(filler.as_bytes(), 1.0, 1.0, true).unwrap();
    }
    fs.unlink(filler.as_bytes()).unwrap();
}

#[test]
fn walks_a_tree_60_000_deep_on_the_modules_stack() {
    const DEPTH: usize = 60_000;
    on_the_modules_stack(|| {
        let (mut fs, switch) = setup();
        let (bottom, links) = build_deep(&mut fs, DEPTH);
        assert!(links >= 1);
        assert!(fs.check());
        fs.stat(bottom.as_bytes(), true).unwrap();
        // Two bytes a level: far longer than a call's argument can be.
        let real = fs.realpath(bottom.as_bytes()).unwrap().len();
        assert_eq!(real, 2 * DEPTH);
        assert_eq!(fs.watch_path(bottom.as_bytes()).unwrap().len(), real);
        let inside = format!("{bottom}/inside");
        let moved = fs.rename(b"/r", inside.as_bytes()).unwrap_err();
        assert_eq!(moved.errno, Errno::Einval);

        // A change at the bottom is logged with its whole path.
        fs.watching = true;
        put(&mut fs, &format!("{bottom}/f"), b"hi");
        let record = 5 + real + "/f".len();
        assert_eq!(fs.events().len(), 2 * record);
        assert!(!fs.events_dropped());
        fs.clear_events();
        fs.watching = false;

        // And it all goes again with no memory at all.
        let (removed, tried) = starved(&switch, || fs.rm(b"/r", true, false));
        removed.unwrap();
        assert_eq!(tried, 0);
        for link in 1..=links {
            fs.unlink(format!("/L{link}").as_bytes()).unwrap();
        }
        assert!(fs.check());
        assert_eq!(fs.totals(), (1, 0));
    });
}

#[test]
fn removes_a_deep_tree_level_by_level() {
    on_the_modules_stack(|| {
        // With memory each directory on the way down is a level of its own.
        let (mut fs, _) = setup();
        build_deep(&mut fs, 20_000);
        fs.rm(b"/r", true, false).unwrap();
        assert!(fs.check());
        assert_eq!(fs.totals(), (1, 0));
    });
}

#[test]
fn removing_allocates_nothing() {
    for watching in [false, true] {
        let (mut fs, switch) = setup();
        fs.mkdir(b"/t/a/b/e", true, f64::NAN).unwrap();
        for i in 0..200 {
            put(&mut fs, &format!("/t/a/f{i}"), b"x");
            put(&mut fs, &format!("/t/a/b/g{i}"), b"y");
        }
        fs.link(b"/t/a/f3", b"/t/a/b/linked").unwrap();
        fs.link(b"/t/a/f3", b"/t/a/b/linked2").unwrap();
        put(&mut fs, "/u", b"u");
        fs.mkdir(b"/v", false, f64::NAN).unwrap();
        let file = fs.open(b"/t/a/f5", O_RDWR, f64::NAN).unwrap();
        let dir = fs.open(b"/t/a/b/e", O_RDONLY, f64::NAN).unwrap();
        fs.watching = watching;
        let (results, tried) = starved(&switch, || {
            [
                fs.unlink(b"/u"),
                fs.rmdir(b"/v"),
                fs.rm(b"/t", true, false),
                fs.handle_close(file),
                fs.handle_close(dir),
            ]
        });
        for result in results {
            result.unwrap();
        }
        if watching {
            // The events had nowhere to go, and that is all that was lost.
            assert!(fs.events_dropped());
        } else {
            assert_eq!(tried, 0);
        }
        assert!(fs.check());
        assert_eq!(fs.totals(), (1, 0));
    }
}

#[test]
fn removes_a_large_directory_with_no_memory_in_time() {
    let (mut fs, switch) = setup();
    fs.mkdir(b"/d", false, f64::NAN).unwrap();
    for i in 0..200_000 {
        put(&mut fs, &format!("/d/{i}"), b"");
    }
    let start = Instant::now();
    let (removed, tried) = starved(&switch, || fs.rm(b"/d", true, false));
    let taken = start.elapsed();
    removed.unwrap();
    assert_eq!(tried, 0);
    assert!(fs.check());
    assert_eq!(fs.totals(), (1, 0));
    // Finding each next entry by a scan of the rest took 38 s, optimised.
    assert!(taken < Duration::from_secs(8), "{taken:?}");
}

#[test]
fn removes_many_hard_links_in_time() {
    let (mut fs, _) = setup();
    fs.mkdir(b"/d", false, f64::NAN).unwrap();
    put(&mut fs, "/d/0", b"");
    for i in 1..100_000 {
        fs.link(b"/d/0", format!("/d/{i}").as_bytes()).unwrap();
    }
    let start = Instant::now();
    fs.rm(b"/d", true, false).unwrap();
    let taken = start.elapsed();
    assert!(fs.check());
    assert_eq!(fs.totals(), (1, 0));
    // Finding each link's entry by a scan took 0.55 s for half as many, optimised.
    assert!(taken < Duration::from_secs(4), "{taken:?}");
}

#[test]
fn a_full_log_costs_a_deep_removal_no_path_walks() {
    let (mut fs, _) = setup();
    build_deep(&mut fs, 40_000);
    fs.watching = true;
    fill_log(&mut fs);
    let full = fs.events().len();
    let start = Instant::now();
    fs.rm(b"/r", true, false).unwrap();
    let taken = start.elapsed();
    // The first event had no room, and nothing was logged after it.
    assert!(fs.events_dropped());
    assert_eq!(fs.events().len(), full);
    // Building every path only to drop it took 5 s, optimised.
    assert!(taken < Duration::from_secs(1), "{taken:?}");
}

#[test]
fn a_full_filesystem_can_be_emptied_by_its_real_paths() {
    let (mut fs, switch) = setup();
    fs.mkdir(b"/real/sub", true, f64::NAN).unwrap();
    put(&mut fs, "/real/sub/g", b"x");
    put(&mut fs, "/real/sub/h", b"x");
    fs.symlink(b"/real", b"/link").unwrap();
    let (results, _) = starved(&switch, || {
        [
            // Through a link the path has to be spliced, which needs memory.
            fs.unlink(b"/link/sub/g").map_err(|failure| failure.errno),
            fs.unlink(b"/real/sub/g").map_err(|failure| failure.errno),
            fs.unlink(b"/link").map_err(|failure| failure.errno),
            fs.rm(b"/real", true, false)
                .map_err(|failure| failure.errno),
        ]
    });
    assert_eq!(results, [Err(Errno::Enospc), Ok(()), Ok(()), Ok(())]);
    assert!(fs.check());
    assert_eq!(fs.totals(), (1, 0));
}
