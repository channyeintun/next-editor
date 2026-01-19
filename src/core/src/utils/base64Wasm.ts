// Standard JS-based Base64 encoding/decoding for maximum reliability
// This avoids any Wasm memory management or string initialization issues

/**
 * Encodes a Uint8Array to a Base64 string using standard JS btoa.
 */
export function encodeBase64Wasm(data: Uint8Array): string {
    let binary = '';
    const chunkSize = 8192; // Process in chunks to avoid stack overflow with apply()
    for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.subarray(i, Math.min(i + chunkSize, data.length));
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

/**
 * Decodes a Base64 string to a Uint8Array using standard JS atob.
 */
export function decodeBase64Wasm(base64: string): Uint8Array {
    try {
        // Clean the string (remove whitespace/newlines)
        const cleanBase64 = base64.replace(/\s/g, '');
        const binary = atob(cleanBase64);
        const result = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            result[i] = binary.charCodeAt(i);
        }
        return result;
    } catch (e) {
        console.error('Base64 Decoding failed:', e);
        return new Uint8Array(0);
    }
}
