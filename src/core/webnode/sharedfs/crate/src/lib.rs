//! webnode's filesystem, run by every worker of a runtime on one shared
//! memory. See ../README.md for the design and `abi.rs` for the contract with
//! the TypeScript binding.
//!
//! `no_std` in the module that ships; the host build (`cargo test`) has std, so
//! the tests can use it.
#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

pub mod abi;
#[cfg(feature = "fs")]
pub mod fs;
#[cfg(feature = "heap")]
pub mod heap;

#[cfg(all(target_arch = "wasm32", feature = "heap", feature = "fs"))]
mod exports;

#[cfg(all(target_arch = "wasm32", feature = "heap"))]
#[global_allocator]
static HEAP: heap::Heap = heap::Heap;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod counting;

#[cfg(all(test, not(target_arch = "wasm32")))]
#[global_allocator]
static COUNTING: counting::Counting = counting::Counting;
