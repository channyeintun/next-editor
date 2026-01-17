import { getWasmExports } from './steganography';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// CHUNK_SIZE must be a multiple of 3 (for encoding) and 4 (for decoding)
const CHUNK_SIZE = 1024 * 1024 * 3; // 3MB chunks

/**
 * Encodes a Uint8Array to a Base64 string using WebAssembly with chunking for large sizes.
 */
export function encodeBase64Wasm(data: Uint8Array): string {
    const exports = getWasmExports();
    if (!exports) {
        // Fallback to legacy JS
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < data.length; i += chunkSize) {
            const chunk = data.subarray(i, Math.min(i + chunkSize, data.length));
            binary += String.fromCharCode(...chunk);
        }
        return btoa(binary);
    }

    const memory = exports.memory;
    const baseOffset = (exports.__heap_base?.value as number) || 65536;

    // We only need enough memory for one chunk (input + output)
    const requiredMemory = baseOffset + (CHUNK_SIZE * 3); // Input + Base64 output overhead
    if (memory.buffer.byteLength < requiredMemory) {
        const pagesNeeded = Math.ceil((requiredMemory - memory.buffer.byteLength) / 65536);
        if (pagesNeeded > 0) memory.grow(pagesNeeded);
    }

    const dataPtr = baseOffset;
    const outPtr = baseOffset + CHUNK_SIZE;

    let result = '';
    for (let i = 0; i < data.length; i += CHUNK_SIZE) {
        const chunkLen = Math.min(CHUNK_SIZE, data.length - i);
        const chunk = data.subarray(i, i + chunkLen);

        new Uint8Array(memory.buffer, dataPtr, chunkLen).set(chunk);
        const actualLen = exports.base64Encode(dataPtr, chunkLen, outPtr);

        const resultBuffer = new Uint8Array(memory.buffer, outPtr, actualLen);
        result += textDecoder.decode(resultBuffer);
    }

    return result;
}

/**
 * Decodes a Base64 string to a Uint8Array using WebAssembly with chunking for large sizes.
 */
export function decodeBase64Wasm(base64: string): Uint8Array {
    const exports = getWasmExports();
    if (!exports) {
        // Fallback to legacy JS
        const binary = atob(base64);
        const result = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            result[i] = binary.charCodeAt(i);
        }
        return result;
    }

    const memory = exports.memory;
    const baseOffset = (exports.__heap_base?.value as number) || 65536;

    // Each character is 1 byte in encoded form
    // DECODE_CHUNK must be a multiple of 4
    const DECODE_CHUNK = 1024 * 1024 * 4; // 4MB of base64 chars

    // Final result buffer
    const finalLen = Math.ceil(base64.length * 3 / 4);
    const finalResult = new Uint8Array(finalLen);
    let decodedTotalLen = 0;

    const requiredMemory = baseOffset + (DECODE_CHUNK * 3);
    if (memory.buffer.byteLength < requiredMemory) {
        const pagesNeeded = Math.ceil((requiredMemory - memory.buffer.byteLength) / 65536);
        if (pagesNeeded > 0) memory.grow(pagesNeeded);
    }

    const strPtr = baseOffset;
    const resultPtr = baseOffset + DECODE_CHUNK;

    for (let i = 0; i < base64.length; i += DECODE_CHUNK) {
        const chunkStr = base64.substring(i, i + DECODE_CHUNK);
        const strBytes = textEncoder.encode(chunkStr);

        new Uint8Array(memory.buffer, strPtr, strBytes.length).set(strBytes);
        const actualLen = exports.base64Decode(strPtr, strBytes.length, resultPtr);

        const resultBuffer = new Uint8Array(memory.buffer, resultPtr, actualLen);
        finalResult.set(resultBuffer, decodedTotalLen);
        decodedTotalLen += actualLen;
    }

    // Shrink if we overestimated (due to padding)
    return decodedTotalLen === finalLen ? finalResult : finalResult.subarray(0, decodedTotalLen).slice();
}
