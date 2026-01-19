import pako from 'pako';
import { encodeBase64, decodeBase64 } from './base64';

// CRC32 implementation for PNG chunks (since pako might not export it directly in all versions)
function crc32(data: Uint8Array): number {
    let crc = -1;
    for (let i = 0; i < data.length; i++) {
        let byte = data[i];
        for (let j = 0; j < 8; j++) {
            if ((crc ^ byte) & 1) {
                crc = (crc >>> 1) ^ 0xEDB88320;
            } else {
                crc = crc >>> 1;
            }
            byte >>= 1;
        }
    }
    return (crc ^ -1) >>> 0;
}

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
export async function encodeDataInCanvas(canvas: HTMLCanvasElement, data: string): Promise<string> {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');

    if (!wasmInstance) {
        throw new Error('Steganography: WebAssembly module not initialized. Call initWasm() first.');
    }

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;

    // Ensure 100% opacity and clear LSBs (optional but cleaner)
    // We also set imageSmoothingEnabled to false on the context
    ctx.imageSmoothingEnabled = false;

    for (let i = 3; i < pixels.length; i += 4) {
        pixels[i] = 255;
    }

    // Compress data using pako
    const compressed = pako.deflate(data);

    const base64Data = encodeBase64(compressed);
    const dataToEncode = MAGIC_PREFIX + base64Data;
    const dataToEncodeBuffer = new TextEncoder().encode(dataToEncode);

    const exports = wasmInstance.exports as unknown as SteganographyWasmExports;
    const memory = exports.memory;
    const baseOffset = (exports.__heap_base?.value as number) || 65536;

    // Need enough memory
    const totalSizeNeeded = baseOffset + pixels.length + dataToEncodeBuffer.length;

    // Check if image has enough capacity (3 bits per pixel + 32 bits header)
    const maxCapacityBits = (pixels.length / 4) * 3;
    const requiredBits = dataToEncodeBuffer.length * 8 + 32;
    if (requiredBits > maxCapacityBits) {
        throw new Error(`Steganography: Data too large for image. Needed ${requiredBits} bits, have ${maxCapacityBits} bits.`);
    }

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

    return dataToEncode;
}

/**
 * Decodes data from an image's pixel data.
 * Requires WebAssembly to be initialized via initWasm().
 * @param canvas The canvas containing the image.
 * @returns The decoded string, or null if no data found or Wasm missing.
 */
export async function decodeDataFromCanvas(canvas: HTMLCanvasElement): Promise<string | null> {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;

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

export function handleDecodedMessage(decoded: string): string | null {
    if (decoded.startsWith(MAGIC_PREFIX)) {
        try {
            const base64Data = decoded.substring(MAGIC_PREFIX.length).trim();

            const bytes = decodeBase64(base64Data);

            if (bytes.length === 0) {
                console.error('Steganography: Decoded base64 resulted in empty bytes');
                return null;
            }

            // Verify Zlib header (0x78)
            if (bytes[0] !== 0x78) {
                const headerHex = bytes[0].toString(16).padStart(2, '0');
                const nextBytes = Array.from(bytes.slice(1, 5)).map(b => b.toString(16).padStart(2, '0')).join(', ');
                console.error(`Steganography: Invalid Zlib header 0x${headerHex}. Following bytes: ${nextBytes}. Corrupted data?`);
                return null;
            }

            const decompressed = pako.inflate(bytes, { to: 'string' });
            return decompressed;
        } catch (e) {
            console.error('Steganography: Failed to decompress data', e);
            return null;
        }
    }
    return null;
}

/**
 * Injects a tEXt chunk into a PNG binary.
 */
export function injectPngMetadata(pngData: Uint8Array, key: string, value: string): Uint8Array {
    const textData = new TextEncoder().encode(key + '\0' + value);
    const chunkLen = textData.length;
    const type = new TextEncoder().encode('tEXt');

    const chunk = new Uint8Array(4 + 4 + chunkLen + 4);
    const view = new DataView(chunk.buffer);

    view.setUint32(0, chunkLen);
    chunk.set(type, 4);
    chunk.set(textData, 8);

    // CRC is calculated on Type + Data
    const crcSource = new Uint8Array(4 + chunkLen);
    crcSource.set(type, 0);
    crcSource.set(textData, 4);
    view.setUint32(8 + chunkLen, crc32(crcSource));

    // Find IEND chunk (last 12 bytes of a standard PNG)
    // We'll insert before it. Standard PNG ends with 00 00 00 00 49 45 4E 44 AE 42 60 82
    const iendOffset = pngData.length - 12;
    if (iendOffset < 0) return pngData;

    const result = new Uint8Array(pngData.length + chunk.length);
    result.set(pngData.subarray(0, iendOffset), 0);
    result.set(chunk, iendOffset);
    result.set(pngData.subarray(iendOffset), iendOffset + chunk.length);

    return result;
}

/**
 * Extracts a tEXt chunk from a PNG binary by key.
 */
export function extractPngMetadata(pngData: Uint8Array, key: string): string | null {
    let offset = 8; // Skip PNG magic
    const decoder = new TextDecoder();

    while (offset + 12 <= pngData.length) {
        const view = new DataView(pngData.buffer, pngData.byteOffset + offset, 8);
        const length = view.getUint32(0);
        const type = decoder.decode(pngData.subarray(offset + 4, offset + 8));

        if (type === 'tEXt') {
            const data = pngData.subarray(offset + 8, offset + 8 + length);
            const content = decoder.decode(data);
            const keyEnd = content.indexOf('\0');
            if (keyEnd !== -1) {
                const foundKey = content.substring(0, keyEnd);
                if (foundKey === key) {
                    return content.substring(keyEnd + 1);
                }
            }
        }

        offset += 12 + length;
    }
    return null;
}
