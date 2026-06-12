let wasmInstance: WebAssembly.Instance | null = null;
let wasmPromise: Promise<WebAssembly.Instance | null> | null = null;

const WASM_PAGE_SIZE = 65536;
const WASM_SCRATCH_BASE_OFFSET = WASM_PAGE_SIZE;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_TAG = 0x80;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface WasmExports {
  memory: WebAssembly.Memory;
  __heap_base?: WebAssembly.Global; // AssemblyScript heap start
  findCommonPrefix(str1Ptr: number, str1Len: number, str2Ptr: number, str2Len: number): number;
  findCommonSuffix(str1Ptr: number, str1Len: number, str2Ptr: number, str2Len: number): number;
}

interface PreparedWasmStringPair {
  bytes1: Uint8Array;
  bytes2: Uint8Array;
  ptr1: number;
  ptr2: number;
}

export interface CommonAffixLengths {
  prefixLen: number;
  suffixLen: number;
}

function getWasmScratchBaseOffset(exports: WasmExports): number {
  return (exports.__heap_base?.value as number) || WASM_SCRATCH_BASE_OFFSET;
}

function prepareWasmStringPair(
  exports: WasmExports,
  str1: string,
  str2: string,
): PreparedWasmStringPair {
  const memory = exports.memory;
  const bytes1 = textEncoder.encode(str1);
  const bytes2 = textEncoder.encode(str2);
  const baseOffset = getWasmScratchBaseOffset(exports);
  const totalSizeNeeded = baseOffset + bytes1.length + bytes2.length;

  if (memory.buffer.byteLength < totalSizeNeeded) {
    const pagesNeeded = Math.ceil((totalSizeNeeded - memory.buffer.byteLength) / WASM_PAGE_SIZE);
    if (pagesNeeded > 0) memory.grow(pagesNeeded);
  }

  new Uint8Array(memory.buffer, baseOffset, bytes1.length).set(bytes1);
  new Uint8Array(memory.buffer, baseOffset + bytes1.length, bytes2.length).set(bytes2);

  return {
    bytes1,
    bytes2,
    ptr1: baseOffset,
    ptr2: baseOffset + bytes1.length,
  };
}

function prefixBytesToCharacterLength(bytes: Uint8Array, prefixBytes: number): number {
  let safePrefixBytes = Math.min(prefixBytes, bytes.length);

  while (
    safePrefixBytes > 0 &&
    safePrefixBytes < bytes.length &&
    (bytes[safePrefixBytes] & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_TAG
  ) {
    safePrefixBytes--;
  }

  if (safePrefixBytes <= 0) return 0;
  return textDecoder.decode(bytes.subarray(0, safePrefixBytes)).length;
}

function suffixBytesToCharacterLength(bytes: Uint8Array, suffixBytes: number): number {
  let safeSuffixBytes = Math.min(suffixBytes, bytes.length);

  while (safeSuffixBytes > 0) {
    const suffixStart = bytes.length - safeSuffixBytes;
    if ((bytes[suffixStart] & UTF8_CONTINUATION_MASK) !== UTF8_CONTINUATION_TAG) {
      break;
    }
    safeSuffixBytes--;
  }

  if (safeSuffixBytes <= 0) return 0;
  return textDecoder.decode(bytes.subarray(bytes.length - safeSuffixBytes)).length;
}

export function findCommonPrefixLengthWasm(str1: string, str2: string): number | null {
  const exports = getWasmExports();
  if (!exports) return null;

  const { bytes1, bytes2, ptr1, ptr2 } = prepareWasmStringPair(exports, str1, str2);
  const prefixBytes = exports.findCommonPrefix(ptr1, bytes1.length, ptr2, bytes2.length);
  return prefixBytesToCharacterLength(bytes1, prefixBytes);
}

export function findCommonSuffixLengthWasm(str1: string, str2: string): number | null {
  const exports = getWasmExports();
  if (!exports) return null;

  const { bytes1, bytes2, ptr1, ptr2 } = prepareWasmStringPair(exports, str1, str2);
  const suffixBytes = exports.findCommonSuffix(ptr1, bytes1.length, ptr2, bytes2.length);
  return suffixBytesToCharacterLength(bytes1, suffixBytes);
}

export function findCommonAffixLengthsWasm(str1: string, str2: string): CommonAffixLengths | null {
  const exports = getWasmExports();
  if (!exports) return null;

  const { bytes1, bytes2, ptr1, ptr2 } = prepareWasmStringPair(exports, str1, str2);
  const prefixBytes = exports.findCommonPrefix(ptr1, bytes1.length, ptr2, bytes2.length);
  const suffixBytes = exports.findCommonSuffix(
    ptr1 + prefixBytes,
    bytes1.length - prefixBytes,
    ptr2 + prefixBytes,
    bytes2.length - prefixBytes,
  );

  return {
    prefixLen: prefixBytesToCharacterLength(bytes1, prefixBytes),
    suffixLen: suffixBytesToCharacterLength(bytes1, suffixBytes),
  };
}

/**
 * Initializes the WebAssembly module.
 *
 * Performance Note:
 * This module uses WebAssembly to optimize string diffing operations
 * which involves iterating over large strings, significantly faster in Wasm.
 *
 * @param url The URL to the .wasm file. If not provided, it defaults to '/next-editor.wasm'.
 */
export async function initWasm(url?: string): Promise<boolean> {
  if (wasmInstance) return true;
  if (wasmPromise) return (await wasmPromise) !== null;

  wasmPromise = (async () => {
    try {
      // Default URL if not provided.
      const wasmUrl = url || "/next-editor.wasm";

      let response: Response;
      try {
        response = await fetch(wasmUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (err) {
        console.warn(`Failed to fetch wasm from ${wasmUrl}:`, err);
        console.warn("Performance optimizations will be disabled.");
        return null;
      }

      const module = await WebAssembly.compileStreaming(response);
      const instance = await WebAssembly.instantiate(module, {
        env: {
          abort: () => console.error("Wasm aborted"),
        },
      });
      wasmInstance = instance;
      console.log("WebAssembly Diffing module initialized from", wasmUrl);
      return instance;
    } catch (e) {
      console.error("Failed to initialize WebAssembly optimized diffing", e);
      return null;
    }
  })();

  return (await wasmPromise) !== null;
}

/**
 * Gets the Wasm exports if available.
 */
export function getWasmExports(): WasmExports | null {
  if (!wasmInstance) return null;
  return wasmInstance.exports as unknown as WasmExports;
}

/**
 * Checks if Wasm is initialized.
 */
export function isWasmInitialized(): boolean {
  return wasmInstance !== null;
}
