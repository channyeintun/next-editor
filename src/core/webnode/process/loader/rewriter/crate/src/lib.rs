//! The loader's rewrite of an ES module's `import` and `export` statements
//! into calls on the loader's bindings (`__webnode_require`,
//! `__webnode_exports`): what sucrase's `imports` transform does in
//! process/loader/transform.ts, for large files, where sucrase's one object
//! per token costs tens of megabytes of heap.
//!
//! The contract is sucrase's, statement for statement (see ../README.md): the
//! same `require` per imported path, the same interop helpers, the same code
//! for each kind of export, every line where it was. What this cannot rewrite
//! the same way it declines, and the caller uses sucrase.

mod rewrite;

pub use rewrite::rewrite;

use std::sync::Mutex;

/// What the last `wnr_rewrite` produced: the code, or why it declined.
static RESULT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

/// Room for `len` bytes of source, for the caller to fill.
#[no_mangle]
pub extern "C" fn wnr_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// Rewrites the `len` bytes of UTF-8 source at `pointer` (from `wnr_alloc`,
/// which this takes back). Answers 1 with the code as the result, 0 with the
/// reason it declined.
///
/// # Safety
/// `pointer` must come from `wnr_alloc(len)` and hold `len` initialised bytes.
#[no_mangle]
pub unsafe extern "C" fn wnr_rewrite(pointer: *mut u8, len: usize) -> u32 {
    let source = Vec::from_raw_parts(pointer, len, len);
    let (ok, bytes) = match String::from_utf8(source) {
        Ok(text) => match rewrite(&text) {
            Ok(code) => (1, code.into_bytes()),
            Err(why) => (0, why.into_bytes()),
        },
        Err(_) => (0, b"the source is not UTF-8".to_vec()),
    };
    *RESULT.lock().unwrap() = bytes;
    ok
}

/// Where the last result is.
#[no_mangle]
pub extern "C" fn wnr_result_ptr() -> *const u8 {
    RESULT.lock().unwrap().as_ptr()
}

/// How long the last result is.
#[no_mangle]
pub extern "C" fn wnr_result_len() -> usize {
    RESULT.lock().unwrap().len()
}

/// Gives the last result's memory back.
#[no_mangle]
pub extern "C" fn wnr_release() {
    *RESULT.lock().unwrap() = Vec::new();
}
