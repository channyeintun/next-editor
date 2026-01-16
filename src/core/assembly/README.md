# AssemblyScript Steganography Module

This directory contains the AssemblyScript source code for the high-performance steganography engine used in `use-next-editor`.

## Why AssemblyScript?

Steganography involves intensive bitwise operations on large arrays of pixel data. While JavaScript is fast, WebAssembly (Wasm) provides predictable performance and is better suited for these types of low-level data manipulations. By using AssemblyScript, we can write TypeScript-like code that compiles to highly efficient WebAssembly.

## Source Files

- `index.ts`: The main entry point containing `encodeLSB` and `decodeLSB` implementations using low-level memory access (`load` and `store`).
- `asconfig.json`: AssemblyScript configuration.

## How it Works

The module uses a raw memory access pattern:
1. Data and Pixels are passed as pointers to the Wasm linear memory.
2. The module performs bitwise LSB (Least Significant Bit) encoding/decoding directly on the memory.
3. This avoids the overhead of object allocation and type conversions during the heavy lifting.

## Building and Serving

To rebuild the WebAssembly module:

1. Navigate to the `src/core` directory.
2. Run the build script:
   ```bash
   npm run asbuild
   ```
3. The compiled binary `steganography.wasm` will be generated in `src/core/dist/`.

### Deployment

To use the WebAssembly optimization in your application:
1. Copy `steganography.wasm` from the library's `dist` folder to your application's `public` folder (or any location served by your web server).
2. Initialize the module at the start of your application:
   ```typescript
   import { initWasm } from 'use-next-editor';

   // Initialize with the path to the wasm file
   initWasm('/path/to/steganography.wasm');
   ```

Note: If no path is provided to `initWasm()`, it defaults to `/steganography.wasm`.

## API

### `encodeLSB(pixelsPtr: usize, pixelsLen: i32, dataPtr: usize, dataLen: i32): void`
Encodes data into pixel bits at the specified memory addresses.

### `decodeLSB(pixelsPtr: usize, pixelsLen: i32, resultPtr: usize, resultMaxLen: i32): i32`
Decodes data from pixel bits and stores it in the result buffer. Returns the length of decoded data or a negative error code.
