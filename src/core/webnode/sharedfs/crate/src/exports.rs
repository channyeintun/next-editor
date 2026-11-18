//! The `fs_*` functions the TypeScript binding calls (../README.md lists them).
//! Each one only reads its arguments from the shared block, calls the
//! filesystem, and writes the outcome back into the block.
use core::mem::MaybeUninit;

use crate::abi::{
    Errno, Shared, Syscall, ARGS_CAPACITY, PATH_NONE, UTIME_ATIME_NOW, UTIME_FOLLOW,
    UTIME_MTIME_NOW,
};
use crate::fs::{Clock, Failure, Fs, Space, Stat};
use crate::heap::Heap;

#[link(wasm_import_module = "env")]
extern "C" {
    /// The host's clock, in epoch milliseconds (`Date.now`).
    #[link_name = "now"]
    fn host_now() -> f64;
}

struct HostClock;

impl Clock for HostClock {
    fn now(&mut self) -> f64 {
        unsafe { host_now() }
    }
}

/// The shared memory, as the allocator over it sees it.
struct HeapSpace;

impl Space for HeapSpace {
    fn can_allocate(&mut self, bytes: usize) -> bool {
        Heap::can_allocate(bytes)
    }
}

type SharedFs = Fs<HostClock, HeapSpace>;

/// Zero until used: it lives in the static area, which a new memory has clean.
static mut SHARED: MaybeUninit<Shared> = MaybeUninit::zeroed();
/// The one filesystem every instance shares, made by `fs_init`.
static mut FS: MaybeUninit<SharedFs> = MaybeUninit::uninit();
static mut READY: bool = false;

/// `syscall` for a call that names none (the binding reads 0 as no name).
const NO_SYSCALL: u32 = 0;

/// The address of the shared block (`abi.rs`).
#[no_mangle]
pub extern "C" fn fs_base() -> *mut Shared {
    (&raw mut SHARED).cast()
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    // The state may be half changed: every later call must fail instead of trusting it.
    unsafe { (*fs_base()).poisoned = 1 };
    core::arch::wasm32::unreachable()
}

fn set_failure(errno: u32, syscall: u32, path_mode: u32) -> i32 {
    let block = fs_base();
    unsafe {
        (*block).errno = errno;
        (*block).syscall = syscall;
        (*block).path_mode = path_mode;
    }
    -1
}

/// Runs one call on the filesystem, refusing with EIO once it is poisoned
/// (or before `fs_init`), and leaves the outcome and the log's state in the
/// block. `syscall` is what that refusal names.
fn run(syscall: u32, op: impl FnOnce(&mut SharedFs) -> Result<i32, Failure>) -> i32 {
    let block = fs_base();
    unsafe {
        if (*block).poisoned != 0 || !READY {
            return set_failure(Errno::Eio as u32, syscall, PATH_NONE);
        }
        let fs = &mut *(&raw mut FS).cast::<SharedFs>();
        // The caller copied the last call's bytes out before this one began.
        fs.trim_scratch();
        fs.watching = (*block).watching != 0;
        fs.checking = (*block).privileged == 0;
        fs.umask = (*block).umask;
        let result = op(fs);
        (*block).events_len = fs.events().len() as u32;
        (*block).events_dropped = fs.events_dropped() as u32;
        match result {
            Ok(value) => {
                (*block).errno = 0;
                value
            }
            Err(failure) => set_failure(
                failure.errno as u32,
                failure.syscall as u32,
                failure.path_mode,
            ),
        }
    }
}

/// The call's two paths: `a` bytes at the start of the argument area, then `b`.
fn paths(a: u32, b: u32, syscall: Syscall) -> Result<(&'static [u8], &'static [u8]), Failure> {
    let (a, b) = (a as usize, b as usize);
    if a > ARGS_CAPACITY || b > ARGS_CAPACITY - a {
        return Err(Failure {
            errno: Errno::Enametoolong,
            syscall,
            path_mode: PATH_NONE,
        });
    }
    // The binding writes the argument area only before a call, under the lock.
    let args: &'static [u8] = unsafe { &(*fs_base()).args };
    Ok((&args[..a], &args[a..a + b]))
}

fn path(a: u32, syscall: Syscall) -> Result<&'static [u8], Failure> {
    paths(a, 0, syscall).map(|(first, _)| first)
}

fn set_bytes(bytes: &[u8]) {
    let block = fs_base();
    unsafe {
        (*block).ptr = bytes.as_ptr() as u32;
        (*block).len = bytes.len() as u32;
    }
}

fn set_aux(aux: u32) {
    unsafe { (*fs_base()).aux = aux };
}

fn set_stat(stat: &Stat) {
    unsafe { (*fs_base()).stat = *stat };
}

/// Makes the root directory the first time it is called.
#[no_mangle]
pub extern "C" fn fs_init() -> i32 {
    unsafe {
        if (*fs_base()).poisoned != 0 {
            return set_failure(Errno::Eio as u32, NO_SYSCALL, PATH_NONE);
        }
        if !READY {
            (&raw mut FS).write(MaybeUninit::new(Fs::with_space(HostClock, HeapSpace)));
            READY = true;
        }
    }
    0
}

#[no_mangle]
pub extern "C" fn fs_stat(a: u32, follow: u32) -> i32 {
    let syscall = if follow != 0 {
        Syscall::Stat
    } else {
        Syscall::Lstat
    };
    run(syscall as u32, |fs| {
        set_stat(&fs.stat(path(a, syscall)?, follow != 0)?);
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_exists(a: u32) -> i32 {
    run(Syscall::Stat as u32, |fs| {
        Ok(fs.presence(path(a, Syscall::Stat)?) as i32)
    })
}

#[no_mangle]
pub extern "C" fn fs_readdir(a: u32) -> i32 {
    run(Syscall::Scandir as u32, |fs| {
        let (listing, count) = fs.readdir(path(a, Syscall::Scandir)?)?;
        set_bytes(listing);
        set_aux(count);
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_mkdir(a: u32, recursive: u32, mode: f64, floor: u32) -> i32 {
    run(Syscall::Mkdir as u32, |fs| {
        match fs.mkdir_above(
            path(a, Syscall::Mkdir)?,
            recursive != 0,
            mode,
            floor as usize,
        )? {
            Some(first) => {
                set_bytes(first);
                set_aux(1);
            }
            None => set_aux(0),
        }
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_rmdir(a: u32) -> i32 {
    run(Syscall::Rmdir as u32, |fs| {
        fs.rmdir(path(a, Syscall::Rmdir)?)?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_unlink(a: u32) -> i32 {
    run(Syscall::Unlink as u32, |fs| {
        fs.unlink(path(a, Syscall::Unlink)?)?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_rm(a: u32, recursive: u32, force: u32) -> i32 {
    run(Syscall::Rm as u32, |fs| {
        fs.rm(path(a, Syscall::Rm)?, recursive != 0, force != 0)?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_rename(a: u32, b: u32) -> i32 {
    run(Syscall::Rename as u32, |fs| {
        let (from, to) = paths(a, b, Syscall::Rename)?;
        fs.rename(from, to)?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_link(a: u32, b: u32) -> i32 {
    run(Syscall::Link as u32, |fs| {
        let (existing, new) = paths(a, b, Syscall::Link)?;
        fs.link(existing, new)?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_copy_file(a: u32, b: u32, mode: u32) -> i32 {
    run(Syscall::Copyfile as u32, |fs| {
        let (source, destination) = paths(a, b, Syscall::Copyfile)?;
        fs.copy_file(source, destination, mode)?;
        Ok(0)
    })
}

/// `a` is the target, `b` the path of the link.
#[no_mangle]
pub extern "C" fn fs_symlink(a: u32, b: u32) -> i32 {
    run(Syscall::Symlink as u32, |fs| {
        let (target, link) = paths(a, b, Syscall::Symlink)?;
        fs.symlink(target, link)?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_readlink(a: u32) -> i32 {
    run(Syscall::Readlink as u32, |fs| {
        set_bytes(fs.readlink(path(a, Syscall::Readlink)?)?);
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_realpath(a: u32) -> i32 {
    run(Syscall::Realpath as u32, |fs| {
        set_bytes(fs.realpath(path(a, Syscall::Realpath)?)?);
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_watch_path(a: u32) -> i32 {
    run(Syscall::Watch as u32, |fs| {
        set_bytes(fs.watch_path(path(a, Syscall::Watch)?)?);
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_chmod(a: u32, mode: u32, follow: u32) -> i32 {
    run(Syscall::Chmod as u32, |fs| {
        fs.chmod(path(a, Syscall::Chmod)?, mode, follow != 0)?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_utimes(a: u32, atime: f64, mtime: f64, flags: u32) -> i32 {
    run(Syscall::Utime as u32, |fs| {
        let atime = (flags & UTIME_ATIME_NOW == 0).then_some(atime);
        let mtime = (flags & UTIME_MTIME_NOW == 0).then_some(mtime);
        fs.utimes(
            path(a, Syscall::Utime)?,
            atime,
            mtime,
            flags & UTIME_FOLLOW != 0,
        )?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_give_to_root(a: u32) -> i32 {
    run(Syscall::Chown as u32, |fs| {
        fs.give_to_root(path(a, Syscall::Chown)?)?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_truncate(a: u32, length: f64) -> i32 {
    run(Syscall::Open as u32, |fs| {
        fs.truncate(path(a, Syscall::Open)?, length)?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_access(a: u32, mode: u32) -> i32 {
    run(Syscall::Access as u32, |fs| {
        fs.access(path(a, Syscall::Access)?, mode)?;
        Ok(0)
    })
}

/// `a` is one candidate path: 1 made, 0 the name is taken.
#[no_mangle]
pub extern "C" fn fs_mkdtemp(a: u32) -> i32 {
    run(Syscall::Mkdtemp as u32, |fs| {
        Ok(fs.mkdtemp(path(a, Syscall::Mkdtemp)?)? as i32)
    })
}

#[no_mangle]
pub extern "C" fn fs_read_file(a: u32) -> i32 {
    run(Syscall::Open as u32, |fs| {
        set_bytes(fs.read_file(path(a, Syscall::Open)?)?);
        Ok(0)
    })
}

/// `ptr`: where the caller copies the `length` bytes.
#[no_mangle]
pub extern "C" fn fs_write_file(a: u32, flags: u32, mode: f64, length: u32) -> i32 {
    run(Syscall::Open as u32, |fs| {
        let room = fs.write_file(path(a, Syscall::Open)?, flags, mode, length as usize)?;
        set_bytes(room);
        Ok(0)
    })
}

/// Returns the handle.
#[no_mangle]
pub extern "C" fn fs_open(a: u32, flags: u32, mode: f64) -> i32 {
    run(Syscall::Open as u32, |fs| {
        Ok(fs.open(path(a, Syscall::Open)?, flags, mode)? as i32)
    })
}

#[no_mangle]
pub extern "C" fn fs_handle_read(handle: u32, length: f64, position: f64) -> i32 {
    run(Syscall::Read as u32, |fs| {
        set_bytes(fs.handle_read(handle, length, position)?);
        Ok(0)
    })
}

/// `ptr`: where the caller copies the `length` bytes.
#[no_mangle]
pub extern "C" fn fs_handle_write(handle: u32, length: u32, position: f64) -> i32 {
    run(Syscall::Write as u32, |fs| {
        set_bytes(fs.handle_write(handle, length as usize, position)?);
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_handle_stat(handle: u32) -> i32 {
    run(Syscall::Fstat as u32, |fs| {
        set_stat(&fs.handle_stat(handle)?);
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_handle_truncate(handle: u32, length: f64) -> i32 {
    run(Syscall::Ftruncate as u32, |fs| {
        fs.handle_truncate(handle, length)?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_handle_chmod(handle: u32, mode: u32) -> i32 {
    run(Syscall::Fchmod as u32, |fs| {
        fs.handle_chmod(handle, mode)?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_handle_utimes(handle: u32, atime: f64, mtime: f64) -> i32 {
    run(Syscall::Futime as u32, |fs| {
        fs.handle_utimes(handle, atime, mtime)?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_handle_close(handle: u32) -> i32 {
    run(Syscall::Close as u32, |fs| {
        fs.handle_close(handle)?;
        Ok(0)
    })
}

/// `ptr`/`len`: the event log.
#[no_mangle]
pub extern "C" fn fs_events() -> i32 {
    run(NO_SYSCALL, |fs| {
        set_bytes(fs.events());
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn fs_events_clear() -> i32 {
    run(NO_SYSCALL, |fs| {
        fs.clear_events();
        Ok(0)
    })
}

/// `stat[0]`: live inodes; `stat[1]`: bytes of file data.
#[no_mangle]
pub extern "C" fn fs_totals() -> i32 {
    run(NO_SYSCALL, |fs| {
        let (inodes, bytes) = fs.totals();
        unsafe {
            (*fs_base()).stat[0] = inodes as f64;
            (*fs_base()).stat[1] = bytes as f64;
        }
        Ok(0)
    })
}

/// 0 when the heap and the tree are consistent, -1 when not, 1 when there was
/// not the memory to look at the tree (tests).
#[no_mangle]
pub extern "C" fn fs_check() -> i32 {
    run(NO_SYSCALL, |fs| {
        Ok(match (fs.try_check(), Heap::check()) {
            (_, false) | (Some(false), _) => -1,
            (None, true) => 1,
            (Some(true), true) => 0,
        })
    })
}
