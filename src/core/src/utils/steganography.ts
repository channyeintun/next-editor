import pako from 'pako';
import { encodeBase64Wasm, decodeBase64Wasm } from './base64Wasm';

/**
 * MAGIC_PREFIX is used to identify data in images.
 */
export const MAGIC_PREFIX = 'NEXT_EDITOR_v2:';

let wasmInstance: WebAssembly.Instance | null = null;
let wasmPromise: Promise<WebAssembly.Instance | null> | null = null;

interface SteganographyWasmExports {
    memory: WebAssembly.Memory;
    __heap_base?: WebAssembly.Global; // AssemblyScript heap start
    encodeLSB(pixelsPtr: number, pixelsLen: number, dataPtr: number, dataLen: number): void;
    decodeLSB(pixelsPtr: number, pixelsLen: number, resultPtr: number, resultMaxLen: number): number;
    findCommonPrefix(str1Ptr: number, str1Len: number, str2Ptr: number, str2Len: number): number;
    findCommonSuffix(str1Ptr: number, str1Len: number, str2Ptr: number, str2Len: number): number;
    base64Encode(dataPtr: number, dataLen: number, outPtr: number): number;
    base64Decode(strPtr: number, strLen: number, outPtr: number): number;
}

/**
 * Initializes the WebAssembly module.
 * 
 * Performance Note:
 * This module uses WebAssembly to optimize the bitwise LSB (Least Significant Bit) 
 * encoding/decoding operations. These operations involve iterating over large 
 * pixel arrays (e.g., 4M+ elements for a 1000x1000 image), which is significantly
 * faster in Wasm.
 * 
 * Memory Layout:
 * - [0...pixels.length]: Pixel data (Uint8Array)
 * - [pixels.length...]: Payload data (Uint8Array)
 * 
 * @param url The URL to the .wasm file. If not provided, it defaults to '/steganography.wasm'.
 */
export async function initWasm(url?: string): Promise<boolean> {
    if (wasmInstance) return true;
    if (wasmPromise) return (await wasmPromise) !== null;

    wasmPromise = (async () => {
        try {
            // Default URL if not provided. In many setups, this would be served from the public folder or absolute path.
            // Users can override this by calling initWasm('/path/to/next-editor.wasm')
            const wasmUrl = url || '/next-editor.wasm';

            let response: Response;
            try {
                response = await fetch(wasmUrl);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
            } catch {
                console.warn(`Failed to fetch wasm from ${wasmUrl}. Steganography will fail as WebAssembly is required.`);
                return null;
            }

            const module = await WebAssembly.compileStreaming(response);
            const instance = await WebAssembly.instantiate(module, {
                env: {
                    abort: () => console.error('Wasm aborted')
                }
            });
            wasmInstance = instance;
            console.log('WebAssembly Steganography module initialized from', wasmUrl);
            return instance;
        } catch (e) {
            console.error('Failed to initialize WebAssembly steganography', e);
            return null;
        }
    })();

    return (await wasmPromise) !== null;
}

/**
 * Gets the Wasm exports if available.
 * Useful for external modules that want to use diff functions.
 */
export function getWasmExports(): SteganographyWasmExports | null {
    if (!wasmInstance) return null;
    return wasmInstance.exports as unknown as SteganographyWasmExports;
}

/**
 * Checks if Wasm is initialized.
 */
export function isWasmInitialized(): boolean {
    return wasmInstance !== null;
}

/**
 * Encodes a string into an image's pixel data using LSB (Least Significant Bit).
 * Requires WebAssembly to be initialized via initWasm().
 * @param canvas The canvas containing the image.
 * @param data The string data to encode.
 */
export async function encodeDataInCanvas(canvas: HTMLCanvasElement, data: string): Promise<void> {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');

    if (!wasmInstance) {
        throw new Error('Steganography: WebAssembly module not initialized. Call initWasm() first.');
    }

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;

    // Compress data using pako
    const compressed = pako.deflate(data);

    const base64Data = encodeBase64Wasm(compressed);
    const dataToEncode = MAGIC_PREFIX + base64Data;
    const dataToEncodeBuffer = new TextEncoder().encode(dataToEncode);

    const exports = wasmInstance.exports as unknown as SteganographyWasmExports;
    const memory = exports.memory;
    const baseOffset = (exports.__heap_base?.value as number) || 65536;

    // Need enough memory
    const totalSizeNeeded = baseOffset + pixels.length + dataToEncodeBuffer.length;
    if (memory.buffer.byteLength < totalSizeNeeded) {
        const pagesNeeded = Math.ceil((totalSizeNeeded - memory.buffer.byteLength) / 65536);
        if (pagesNeeded > 0) memory.grow(pagesNeeded);
    }

    const pixelsPtr = baseOffset;
    const dataPtr = baseOffset + pixels.length;

    const wasmPixels = new Uint8Array(memory.buffer, pixelsPtr, pixels.length);
    const wasmData = new Uint8Array(memory.buffer, dataPtr, dataToEncodeBuffer.length);

    wasmPixels.set(pixels);
    wasmData.set(dataToEncodeBuffer);

    exports.encodeLSB(pixelsPtr, pixels.length, dataPtr, dataToEncodeBuffer.length);

    // Copy back
    pixels.set(wasmPixels);
    ctx.putImageData(imageData, 0, 0);
}

/**
 * Decodes data from an image's pixel data.
 * Requires WebAssembly to be initialized via initWasm().
 * @param canvas The canvas containing the image.
 * @returns The decoded string, or null if no data found or Wasm missing.
 */
export async function decodeDataFromCanvas(canvas: HTMLCanvasElement): Promise<string | null> {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    if (!wasmInstance) {
        console.warn('Steganography: WebAssembly module not initialized. Call initWasm() first.');
        return null;
    }

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;

    const exports = wasmInstance.exports as unknown as SteganographyWasmExports;
    const memory = exports.memory;
    const baseOffset = (exports.__heap_base?.value as number) || 65536;

    // Need enough memory for pixels
    if (memory.buffer.byteLength < baseOffset + pixels.length * 2) {
        const pagesNeeded = Math.ceil((baseOffset + pixels.length * 2 - memory.buffer.byteLength) / 65536);
        if (pagesNeeded > 0) memory.grow(pagesNeeded);
    }

    const pixelsPtr = baseOffset;
    const resultPtr = baseOffset + pixels.length;
    const resultMaxLen = pixels.length;

    const wasmPixels = new Uint8Array(memory.buffer, pixelsPtr, pixels.length);
    wasmPixels.set(pixels);

    const byteCount = exports.decodeLSB(pixelsPtr, pixels.length, resultPtr, resultMaxLen);
    if (byteCount > 0) {
        const resultBuffer = new Uint8Array(memory.buffer, resultPtr, byteCount);
        const decoded = new TextDecoder().decode(resultBuffer);
        return handleDecodedMessage(decoded);
    }

    return null;
}

function handleDecodedMessage(decoded: string): string | null {
    if (decoded.startsWith(MAGIC_PREFIX)) {
        try {
            const base64Data = decoded.substring(MAGIC_PREFIX.length);
            const bytes = decodeBase64Wasm(base64Data);
            const decompressed = pako.inflate(bytes, { to: 'string' });
            return decompressed;
        } catch (e) {
            console.error('Failed to decompress data', e);
            return null;
        }
    }
    return null;
}
