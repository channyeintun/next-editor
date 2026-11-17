//! Running out of memory at any point of any operation, on random trees.
//!
//! Every operation of a random sequence is run again and again with memory
//! refused after `k` grants, for every `k` it asks (and, with `SINGLE` set,
//! with only its `k`-th question refused). Three things must hold:
//!
//! - a call that fails with ENOSPC leaves everything that can be observed as
//!   it was: every node (number, mode, links, times, size, content, target),
//!   every directory's entries and their order, the open handles, the totals,
//!   the event log, whether it has dropped events, and the inode number the
//!   next file gets;
//! - a call that fails for another reason with memory to spare fails for
//!   that reason, not with ENOSPC;
//! - a call that succeeds does what it does with memory to spare. Only its
//!   events may differ: some dropped, or, for `rm -r` with no memory to sort
//!   a directory, the same events in the order of the names.
//!
//! A failed call may read the clock; nothing else of it shows.
use super::*;
use crate::abi::Errno;
use std::cell::Cell;
use std::collections::BTreeMap as Map;
use std::format;
use std::rc::Rc;
use std::string::String;
use std::vec;

#[derive(Clone)]
struct Tick(Rc<Cell<f64>>);
impl Clock for Tick {
    fn now(&mut self) -> f64 {
        let t = self.0.get() + 1.0;
        self.0.set(t);
        t
    }
}

#[derive(Clone)]
struct Budget {
    left: Rc<Cell<Option<u32>>>,
    asked: Rc<Cell<u32>>,
    only: Rc<Cell<Option<u32>>>,
}
impl Space for Budget {
    fn can_allocate(&mut self, _bytes: usize) -> bool {
        self.asked.set(self.asked.get() + 1);
        if let Some(q) = self.only.get() {
            return self.asked.get() != q;
        }
        match self.left.get() {
            None => true,
            Some(0) => false,
            Some(n) => {
                self.left.set(Some(n - 1));
                true
            }
        }
    }
}

type F = Fs<Tick, Budget>;

fn make() -> (F, Budget, Rc<Cell<f64>>) {
    let b = Budget {
        left: Rc::new(Cell::new(None)),
        asked: Rc::new(Cell::new(0)),
        only: Rc::new(Cell::new(None)),
    };
    let c = Rc::new(Cell::new(0.0));
    let mut fs = Fs::with_space(Tick(c.clone()), b.clone());
    fs.watching = true;
    (fs, b, c)
}

#[derive(Clone, Debug)]
enum Op {
    WriteFile(String, u32, usize),
    Open(String, u32),
    HWrite(u32, usize, f64),
    HRead(u32, f64, f64),
    HTrunc(u32, f64),
    HClose(u32),
    Mkdir(String, bool),
    Rmdir(String),
    Unlink(String),
    Rm(String, bool, bool),
    Rename(String, String),
    Link(String, String),
    Symlink(String, String),
    Copy(String, String, u32),
    Truncate(String, f64),
    Mkdtemp(String),
    Chmod(String),
    Utimes(String),
    ReadFile(String),
    Readdir(String),
    Realpath(String),
    ClearEvents,
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn path(r: &mut Rng) -> String {
    const PARTS: [&str; 8] = ["a", "b", "d", "e", "l", "h", "..", "d"];
    let depth = 1 + r.below(4);
    let mut p = String::new();
    for _ in 0..depth {
        p.push('/');
        p.push_str(PARTS[r.below(PARTS.len() as u64) as usize]);
    }
    if r.below(8) == 0 {
        p.push('/');
    }
    p
}

fn op(r: &mut Rng) -> Op {
    let flags = [
        O_WRONLY | O_CREAT | O_TRUNC,
        O_WRONLY | O_CREAT | O_TRUNC | O_EXCL,
        O_WRONLY | O_CREAT | O_APPEND,
        O_RDWR,
        O_RDWR | O_CREAT,
        O_RDONLY,
    ];
    let len = [0usize, 1, 3, 17, 100, 5000][r.below(6) as usize];
    let pos = [f64::NAN, 0.0, 2.0, 50.0, 9000.0][r.below(5) as usize];
    match r.below(23) {
        0 | 1 | 2 => Op::WriteFile(path(r), flags[r.below(6) as usize], len),
        3 | 4 => Op::Open(path(r), flags[r.below(6) as usize]),
        5 | 6 => Op::HWrite(r.below(4) as u32, len, pos),
        7 => Op::HRead(r.below(4) as u32, 10.0, pos),
        8 => Op::HTrunc(r.below(4) as u32, [0.0, 2.0, 8000.0][r.below(3) as usize]),
        9 => Op::HClose(r.below(4) as u32),
        10 | 11 => Op::Mkdir(path(r), r.below(2) == 0),
        12 => Op::Rmdir(path(r)),
        13 => Op::Unlink(path(r)),
        14 => Op::Rm(path(r), r.below(2) == 0, r.below(2) == 0),
        15 => Op::Rename(path(r), path(r)),
        16 => Op::Link(path(r), path(r)),
        17 => Op::Symlink(path(r), path(r)),
        18 => Op::Copy(path(r), path(r), r.below(2) as u32),
        19 => Op::Truncate(path(r), [0.0, 2.0, 8000.0][r.below(3) as usize]),
        20 => Op::Mkdtemp(path(r)),
        21 => [
            Op::Chmod(path(r)),
            Op::Utimes(path(r)),
            Op::ReadFile(path(r)),
            Op::Readdir(path(r)),
            Op::Realpath(path(r)),
        ][r.below(5) as usize]
            .clone(),
        _ => Op::ClearEvents,
    }
}

fn run(fs: &mut F, o: &Op, i: usize) -> core::result::Result<String, Failure> {
    let fill = |s: &mut [u8]| {
        s.iter_mut()
            .enumerate()
            .for_each(|(j, b)| *b = (i + j) as u8 | 1)
    };
    Ok(match o {
        Op::WriteFile(p, f, n) => {
            fill(fs.write_file(p.as_bytes(), *f, f64::NAN, *n)?);
            String::new()
        }
        Op::Open(p, f) => format!("{}", fs.open(p.as_bytes(), *f, f64::NAN)?),
        Op::HWrite(h, n, pos) => {
            fill(fs.handle_write(*h, *n, *pos)?);
            String::new()
        }
        Op::HRead(h, n, pos) => format!("{:?}", fs.handle_read(*h, *n, *pos)?),
        Op::HTrunc(h, n) => format!("{:?}", fs.handle_truncate(*h, *n)?),
        Op::HClose(h) => format!("{:?}", fs.handle_close(*h)?),
        Op::Mkdir(p, rec) => format!(
            "{:?}",
            fs.mkdir(p.as_bytes(), *rec, f64::NAN)?.map(|x| x.to_vec())
        ),
        Op::Rmdir(p) => format!("{:?}", fs.rmdir(p.as_bytes())?),
        Op::Unlink(p) => format!("{:?}", fs.unlink(p.as_bytes())?),
        Op::Rm(p, a, b) => format!("{:?}", fs.rm(p.as_bytes(), *a, *b)?),
        Op::Rename(a, b) => format!("{:?}", fs.rename(a.as_bytes(), b.as_bytes())?),
        Op::Link(a, b) => format!("{:?}", fs.link(a.as_bytes(), b.as_bytes())?),
        Op::Symlink(a, b) => format!("{:?}", fs.symlink(a.as_bytes(), b.as_bytes())?),
        Op::Copy(a, b, m) => format!("{:?}", fs.copy_file(a.as_bytes(), b.as_bytes(), *m)?),
        Op::Truncate(p, n) => format!("{:?}", fs.truncate(p.as_bytes(), *n)?),
        Op::Mkdtemp(p) => format!("{:?}", fs.mkdtemp(p.as_bytes())?),
        Op::Chmod(p) => format!("{:?}", fs.chmod(p.as_bytes(), 0o600, true)?),
        Op::Utimes(p) => format!("{:?}", fs.utimes(p.as_bytes(), 5.0, 6.0, true)?),
        Op::ReadFile(p) => format!("{:?}", fs.read_file(p.as_bytes())?),
        Op::Readdir(p) => {
            let (l, n) = fs.readdir(p.as_bytes())?;
            format!("{:?} {n}", l)
        }
        Op::Realpath(p) => format!("{:?}", fs.realpath(p.as_bytes())?.to_vec()),
        Op::ClearEvents => {
            fs.clear_events();
            String::new()
        }
    })
}

#[derive(PartialEq, Debug, Clone)]
struct Snap {
    tree: Vec<String>,
    handles: Vec<String>,
    next_handle: u32,
    next_ino: u64,
    totals: (u64, u64),
    events: Vec<u8>,
    dropped: bool,
    check: bool,
}

fn node_line(fs: &F, n: Idx) -> String {
    let x = fs.node(n);
    let k = match &x.kind {
        Kind::File(f) => format!(
            "F size={} cap={} {:?}",
            f.size,
            f.data.len(),
            &f.data[..f.size]
        ),
        Kind::Dir(e) => {
            let mut v: Vec<_> = e
                .iter()
                .map(|(k, e)| (e.seq, String::from_utf8_lossy(k).into_owned()))
                .collect();
            v.sort();
            format!("D order={:?}", v.iter().map(|x| &x.1).collect::<Vec<_>>())
        }
        Kind::Symlink(t) => format!("L {:?}", String::from_utf8_lossy(t)),
    };
    format!(
        "ino={} perm={:o} nlink={} a={} m={} c={} b={} {k}",
        x.ino, x.perm, x.nlink, x.atime, x.mtime, x.ctime, x.birthtime
    )
}

fn snap(fs: &F) -> Snap {
    let mut tree = vec![format!("/ {}", node_line(fs, fs.root))];
    let mut st = vec![(fs.root, String::new())];
    while let Some((d, p)) = st.pop() {
        for (name, e) in fs.entries(d) {
            let path = format!("{p}/{}", String::from_utf8_lossy(name));
            tree.push(format!("{path} {}", node_line(fs, e.node)));
            if fs.node(e.node).is_dir() {
                st.push((e.node, path));
            }
        }
    }
    tree.sort();
    let mut handles = vec![];
    for (i, h) in fs.handles.iter().enumerate() {
        if let Some(h) = h {
            handles.push(format!(
                "{i} flags={:o} off={} {}",
                h.flags,
                h.offset,
                node_line(fs, h.node)
            ));
        }
    }
    Snap {
        tree,
        handles,
        next_handle: fs
            .free_handles
            .last()
            .copied()
            .unwrap_or(fs.handles.len() as u32),
        next_ino: fs.next_ino,
        totals: fs.totals(),
        events: fs.events.clone(),
        dropped: fs.events_dropped,
        check: fs.check(),
    }
}

fn replay(ops: &[Op]) -> (F, Budget, Rc<Cell<f64>>) {
    let (mut fs, b, c) = make();
    for (i, o) in ops.iter().enumerate() {
        fs.trim_scratch();
        let _ = run(&mut fs, o, i);
    }
    (fs, b, c)
}

fn diff(a: &Snap, b: &Snap) -> String {
    let mut s = String::new();
    for l in &a.tree {
        if !b.tree.contains(l) {
            s += &format!("\n  - {l}");
        }
    }
    for l in &b.tree {
        if !a.tree.contains(l) {
            s += &format!("\n  + {l}");
        }
    }
    if a.handles != b.handles {
        s += &format!("\n  handles {:?} -> {:?}", a.handles, b.handles);
    }
    if a.next_handle != b.next_handle {
        s += &format!("\n  next_handle {} -> {}", a.next_handle, b.next_handle);
    }
    if a.next_ino != b.next_ino {
        s += &format!("\n  next_ino {} -> {}", a.next_ino, b.next_ino);
    }
    if a.totals != b.totals {
        s += &format!("\n  totals {:?} -> {:?}", a.totals, b.totals);
    }
    if a.events != b.events {
        s += &format!(
            "\n  events {:?} -> {:?}",
            String::from_utf8_lossy(&a.events),
            String::from_utf8_lossy(&b.events)
        );
    }
    if a.dropped != b.dropped {
        s += &format!("\n  dropped {} -> {}", a.dropped, b.dropped);
    }
    if a.check != b.check {
        s += &format!("\n  check {} -> {}", a.check, b.check);
    }
    s
}

/// `line` without the field that starts with `field`, up to the next space.
/// A successful call may leave a file's buffer with another capacity when
/// memory was short (the growth falls back to the exact need), which nothing
/// can observe. A removal with no memory to sort by takes the entries in the
/// order of their names, so the tick each is stamped with (the changed time
/// of a file that lives on, open or linked elsewhere) follows that order.
fn without(line: &str, field: &str) -> String {
    match line.find(field) {
        None => line.into(),
        Some(start) => {
            let rest = &line[start + 1..];
            let end = rest.find(' ').map_or(line.len(), |at| start + 1 + at);
            format!("{}{}", &line[..start], &line[end..])
        }
    }
}

/// The records of an event log, sorted: what was logged, whatever the order.
fn records(log: &[u8]) -> Vec<Vec<u8>> {
    let mut records = Vec::new();
    let mut at = 0;
    while at < log.len() {
        let length = u32::from_le_bytes(log[at + 1..at + 5].try_into().unwrap()) as usize;
        records.push(log[at..at + 5 + length].to_vec());
        at += 5 + length;
    }
    records.sort();
    records
}

fn kind(o: &Op) -> String {
    let s = format!("{o:?}");
    s.split('(').next().unwrap().into()
}

#[test]
fn running_out_at_any_point_of_random_operations_changes_nothing() {
    let seeds: u64 = std::env::var("SEEDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(150);
    let len = 40;
    let mut fails: Map<String, (usize, String)> = Map::new();
    let mut enospc_ok = 0usize;
    let mut success_ok = 0usize;
    for seed in 1..=seeds {
        let mut r = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
        // A seeded prefix that makes a populated tree.
        let mut ops = vec![
            Op::Mkdir("/d/e".into(), true),
            Op::WriteFile("/a".into(), O_WRONLY | O_CREAT | O_TRUNC, 3),
            Op::WriteFile("/d/b".into(), O_WRONLY | O_CREAT | O_TRUNC, 100),
            Op::Symlink("/d".into(), "/l".into()),
            Op::Link("/a".into(), "/h".into()),
            Op::Open("/a".into(), O_RDWR),
            Op::Open("/d/b".into(), O_RDWR | O_APPEND),
            Op::Unlink("/d/b".into()),
        ];
        for _ in 0..len {
            ops.push(op(&mut r));
        }
        for i in 8..ops.len() {
            // How many questions does this op ask with unlimited space?
            let (mut fs, b, _) = replay(&ops[..i]);
            fs.trim_scratch();
            b.asked.set(0);
            let reference = run(&mut fs, &ops[i], i);
            let ref_snap = snap(&fs);
            let asked = b.asked.get();
            let single = std::env::var("SINGLE").is_ok();
            for k in 0..=asked {
                let (mut fs, b, _) = replay(&ops[..i]);
                fs.trim_scratch();
                let before = snap(&fs);
                if single {
                    b.asked.set(0);
                    b.only.set(Some(k + 1));
                } else {
                    b.left.set(Some(k));
                }
                let got = run(&mut fs, &ops[i], i);
                b.left.set(None);
                b.only.set(None);
                let after = snap(&fs);
                match &got {
                    Err(f) if f.errno == Errno::Enospc => {
                        let d = diff(&before, &after);
                        if !d.is_empty() {
                            let key = format!("ENOSPC changed state: {}", kind(&ops[i]));
                            fails.entry(key).or_insert((
                                0,
                                format!("seed {seed} op {i} {:?} k={k} err={f:?}{d}", ops[i]),
                            ));
                            fails
                                .get_mut(&format!("ENOSPC changed state: {}", kind(&ops[i])))
                                .unwrap()
                                .0 += 1;
                        } else {
                            enospc_ok += 1;
                        }
                        // With memory it fails for another reason: that reason comes first.
                        // (Not for mkdir -p, which makes directories on its way to the
                        // one it cannot make, and so can run out before it gets there.)
                        if let Err(rf) = &reference {
                            if rf.errno != Errno::Enospc && !matches!(ops[i], Op::Mkdir(_, true)) {
                                let key = format!(
                                    "ENOSPC where unlimited gives {:?}: {}",
                                    rf.errno,
                                    kind(&ops[i])
                                );
                                fails.entry(key.clone()).or_insert((
                                    0,
                                    format!(
                                        "seed {seed} op {i} {:?} k={k} got {f:?} ref {rf:?}",
                                        ops[i]
                                    ),
                                ));
                                fails.get_mut(&key).unwrap().0 += 1;
                            }
                        }
                    }
                    _ => {
                        let mut a = after.clone();
                        let mut r2 = ref_snap.clone();
                        let same_result = format!("{got:?}") == format!("{reference:?}");
                        let events_ok = a.events == r2.events
                            || a.dropped
                            || (matches!(ops[i], Op::Rm(..))
                                && records(&a.events) == records(&r2.events));
                        a.events.clear();
                        r2.events.clear();
                        a.dropped = false;
                        r2.dropped = false;
                        // What cannot be observed, or follows from the order of
                        // a removal with no memory to sort by.
                        let removal = matches!(ops[i], Op::Rm(..));
                        for snap in [&mut a, &mut r2] {
                            for line in snap.tree.iter_mut().chain(snap.handles.iter_mut()) {
                                *line = without(line, " cap=");
                                if removal {
                                    *line = without(line, " c=");
                                }
                            }
                        }
                        let d = diff(&r2, &a);
                        if !same_result || !d.is_empty() || !events_ok {
                            let key = format!("success differs from unlimited: {}", kind(&ops[i]));
                            fails.entry(key.clone()).or_insert((0, format!(
                                "seed {seed} op {i} {:?} k={k} got={got:?} ref={reference:?} events_ok={events_ok}{d}",
                                ops[i]
                            )));
                            fails.get_mut(&key).unwrap().0 += 1;
                        } else {
                            success_ok += 1;
                        }
                    }
                }
            }
        }
    }
    let mut report = String::new();
    for (k, (n, ex)) in &fails {
        report += &format!("== {k} x{n}\n  {ex}\n");
    }
    assert!(fails.is_empty(), "{report}");
    // It did run out, and did go on, often enough to mean something.
    assert!(
        enospc_ok > 100 && success_ok > 1000,
        "enospc_ok={enospc_ok} success_ok={success_ok}"
    );
}

fn put(fs: &mut F, p: &str, n: usize, flags: u32) -> Result<()> {
    fs.write_file(p.as_bytes(), flags, f64::NAN, n)
        .map(|s| s.fill(b'x'))
}
const W: u32 = O_WRONLY | O_CREAT | O_TRUNC;

/// Runs `call` after `setup` with memory refused after `k` grants, for
/// every `k` until it no longer runs out. Each ENOSPC must leave everything
/// as it was. Returns how often it ran out, and its last result.
fn each_budget(setup: &dyn Fn(&mut F), call: &dyn Fn(&mut F) -> String) -> (u32, String) {
    for k in 0..64 {
        let (mut fs, budget, _) = make();
        setup(&mut fs);
        fs.trim_scratch();
        let before = snap(&fs);
        budget.left.set(Some(k));
        let result = call(&mut fs);
        budget.left.set(None);
        if !result.contains("Enospc") {
            return (k, result);
        }
        let difference = diff(&before, &snap(&fs));
        assert!(difference.is_empty(), "k={k} {result}{difference}");
    }
    panic!("still out of memory with 64 grants");
}

#[test]
fn a_failed_create_leaves_no_trace() {
    // The file's data did not fit: no event, the parent's times unmoved, and
    // the next file gets the inode number this one would have had.
    let (ran_out, result) = each_budget(
        &|fs| {
            fs.mkdir(b"/d", false, f64::NAN).unwrap();
        },
        &|fs| format!("{:?}", put(fs, "/d/new", 10, W)),
    );
    assert!(ran_out >= 2, "{ran_out}");
    assert_eq!(result, "Ok(())");

    let (mut fs, budget, _) = make();
    let (mut reference, _, _) = make();
    for made in [&mut fs, &mut reference] {
        made.mkdir(b"/d", false, f64::NAN).unwrap();
    }
    budget.left.set(Some(1));
    assert_eq!(
        put(&mut fs, "/d/new", 10, W).unwrap_err().errno,
        Errno::Enospc
    );
    budget.left.set(None);
    for made in [&mut fs, &mut reference] {
        put(made, "/d/next", 1, W).unwrap();
    }
    assert_eq!(
        fs.stat(b"/d/next", true).unwrap()[1],
        reference.stat(b"/d/next", true).unwrap()[1]
    );
}

#[test]
fn a_failed_mkdir_p_leaves_no_trace() {
    let (ran_out, result) = each_budget(
        &|fs| {
            fs.mkdir(b"/d", false, f64::NAN).unwrap();
        },
        &|fs| {
            format!(
                "{:?}",
                fs.mkdir(b"/d/x/y/z", true, f64::NAN)
                    .map(|made| made.map(<[u8]>::to_vec))
            )
        },
    );
    // It ran out before the first, between them and before the last.
    assert!(ran_out >= 3, "{ran_out}");
    assert!(result.starts_with("Ok(Some("), "{result}");
}

#[test]
fn every_adding_operation_fails_whole() {
    let file = |path: &'static str, size: usize| move |fs: &mut F| put(fs, path, size, W).unwrap();
    let cases: [(&str, &dyn Fn(&mut F), &dyn Fn(&mut F) -> String); 9] = [
        ("writeFile over a file", &file("/f", 100), &|fs| {
            format!("{:?}", put(fs, "/f", 1000, W))
        }),
        (
            "rename over a file",
            &|fs| {
                put(fs, "/a", 3, W).unwrap();
                put(fs, "/b", 5, W).unwrap();
            },
            &|fs| format!("{:?}", fs.rename(b"/a", b"/b")),
        ),
        ("copyFile", &file("/a", 3000), &|fs| {
            format!("{:?}", fs.copy_file(b"/a", b"/c", 0))
        }),
        (
            "copyFile over a file",
            &|fs| {
                put(fs, "/a", 3000, W).unwrap();
                put(fs, "/c", 1, W).unwrap();
            },
            &|fs| format!("{:?}", fs.copy_file(b"/a", b"/c", 0)),
        ),
        ("symlink", &|_| {}, &|fs| {
            format!("{:?}", fs.symlink(b"/t", b"/s"))
        }),
        ("link", &file("/a", 1), &|fs| {
            format!("{:?}", fs.link(b"/a", b"/h"))
        }),
        ("truncate up", &file("/a", 1), &|fs| {
            format!("{:?}", fs.truncate(b"/a", 5000.0))
        }),
        ("open creating", &|_| {}, &|fs| {
            format!("{:?}", fs.open(b"/n", O_RDWR | O_CREAT, f64::NAN))
        }),
        (
            "a write past the end",
            &|fs| {
                put(fs, "/a", 1, W).unwrap();
                fs.open(b"/a", O_RDWR, f64::NAN).unwrap();
            },
            &|fs| format!("{:?}", fs.handle_write(0, 10, 5000.0).map(|_| ())),
        ),
    ];
    for (name, setup, call) in cases {
        let (ran_out, result) = each_budget(setup, call);
        assert!(ran_out >= 1, "{name} never ran out");
        assert!(result.starts_with("Ok("), "{name}: {result}");
    }
}

#[test]
fn an_open_that_cannot_succeed_names_its_own_error_with_no_memory() {
    // The handle table would have to grow for these, and there is no memory:
    // the path is still looked at first.
    let existing = |fs: &mut F| put(fs, "/a", 1, W).unwrap();
    let cases: [(&dyn Fn(&mut F), &[u8], u32, Errno); 4] = [
        (&existing, b"/a", O_RDWR | O_CREAT | O_EXCL, Errno::Eexist),
        (&|_| {}, b"/nope/n", O_RDWR | O_CREAT, Errno::Enoent),
        (&existing, b"/a/n", O_RDWR | O_CREAT, Errno::Enotdir),
        (&|_| {}, b"/", O_RDWR | O_CREAT, Errno::Eisdir),
    ];
    for (setup, path, flags, errno) in cases {
        let (mut fs, budget, _) = make();
        setup(&mut fs);
        let before = snap(&fs);
        budget.left.set(Some(0));
        let failure = fs.open(path, flags, f64::NAN).unwrap_err();
        budget.left.set(None);
        assert_eq!(failure.errno, errno, "{}", String::from_utf8_lossy(path));
        assert_eq!(diff(&before, &snap(&fs)), "");
    }
}
