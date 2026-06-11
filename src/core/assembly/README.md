# AssemblyScript String Diffing Module

This directory contains the AssemblyScript source code for the high-performance string diffing engine used in Next Editor.

## Why AssemblyScript?

String diffing operations involve intensive byte comparisons on potentially large text content. While JavaScript is fast, WebAssembly (Wasm) provides predictable performance and is better suited for low-level data manipulations. By using AssemblyScript, we can write TypeScript-like code that compiles to highly efficient WebAssembly.

## Source Files

- `index.ts`: The main entry point containing `findCommonPrefix` and `findCommonSuffix` implementations using low-level memory access.
- `tsconfig.json`: TypeScript configuration for AssemblyScript.

## How it Works

The module uses a raw memory access pattern:

1. UTF-8 encoded string bytes are passed as pointers to Wasm linear memory.
2. The module compares bytes directly in memory to find common prefixes/suffixes.
3. For prefix matching, it uses 8-byte (u64) chunked comparison for speed, then falls back to byte-by-byte for the final match position.
4. This avoids the overhead of object allocation and type conversions during the heavy lifting.

## Building

To rebuild the WebAssembly module:

1. Navigate to the `src/core` directory.
2. Run the build script:
   ```bash
   npm run asbuild
   ```
3. The compiled binary `next-editor.wasm` will be generated in `src/core/build/`.

## Deployment

To use the WebAssembly optimization in your application:

1. Copy `next-editor.wasm` from the library's `build` folder to your application's `public` folder (or any location served by your web server).
2. Initialize the module at the start of your application:

   ```typescript
   import { initWasm } from "use-next-editor";

   // Initialize with the path to the wasm file
   await initWasm("/next-editor.wasm");
   ```

> **Note:** If no path is provided to `initWasm()`, it defaults to `/next-editor.wasm`.

## API

### `findCommonPrefix(str1Ptr, str1Len, str2Ptr, str2Len): i32`

Finds the length of common prefix between two byte arrays.

**Parameters:**

- `str1Ptr: usize` - Pointer to first string bytes in memory
- `str1Len: i32` - Length of first string in bytes
- `str2Ptr: usize` - Pointer to second string bytes in memory
- `str2Len: i32` - Length of second string in bytes

**Returns:** Length of common prefix in bytes.

**Algorithm:**

- Processes 8 bytes at a time using u64 comparison
- Falls back to byte-by-byte for final position

### `findCommonSuffix(str1Ptr, str1Len, str2Ptr, str2Len): i32`

Finds the length of common suffix between two byte arrays.

**Parameters:**

- `str1Ptr: usize` - Pointer to first string bytes in memory
- `str1Len: i32` - Length of first string in bytes
- `str2Ptr: usize` - Pointer to second string bytes in memory
- `str2Len: i32` - Length of second string in bytes

**Returns:** Length of common suffix in bytes.

## Usage in Delta Compression

These functions are used to compute `ContentDelta` for frame compression:

```typescript
// In frameDelta.ts
function createContentDelta(prev: string, next: string): ContentDelta | null {
  const prefixLen = findCommonPrefixLength(prev, next); // Uses WASM
  const suffixLen = findCommonSuffixLength(prev, next); // Uses WASM

  return {
    prefixLen,
    suffixLen,
    insert: next.slice(prefixLen, next.length - suffixLen),
  };
}
```

The WASM module accelerates these operations, which are called frequently during recording (on every keystroke) and during playback (frame reconstruction).
