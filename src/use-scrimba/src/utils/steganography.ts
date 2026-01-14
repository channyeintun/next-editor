import pako from 'pako';

/**
 * MAGIC_PREFIX is used to identify Scrimba data in images.
 */
export const MAGIC_PREFIX = 'SCRIMBA_v2:';



/**
 * Encodes a string into an image's pixel data using LSB (Least Significant Bit).
 * @param canvas The canvas containing the image.
 * @param data The string data to encode.
 */
export function encodeDataInCanvas(canvas: HTMLCanvasElement, data: string): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;

    // Compress data using pako
    const compressed = pako.deflate(data);

    // Create V2 formatted data: Prefix + Base64 of compressed data
    // We use Base64 to make it easier to handle as a string in our current LSB implementation
    // Convert to base64 in chunks to avoid stack overflow with large data
    let binaryString = '';
    const chunkSize = 8192;
    for (let i = 0; i < compressed.length; i += chunkSize) {
        const chunk = compressed.subarray(i, Math.min(i + chunkSize, compressed.length));
        binaryString += String.fromCharCode.apply(null, Array.from(chunk));
    }
    const base64Data = btoa(binaryString);
    const dataToEncode = MAGIC_PREFIX + base64Data;


    const binaryData = stringToBinary(dataToEncode);
    const dataLength = binaryData.length;

    // Store data length in first 32 bits
    const lengthBinary = dataLength.toString(2).padStart(32, '0');

    let bitIndex = 0;

    // Encode length
    for (let i = 0; i < 32; i++) {
        const pixelIndex = Math.floor(bitIndex / 3) * 4;
        const colorChannel = bitIndex % 3;
        const bit = parseInt(lengthBinary[i]);
        pixels[pixelIndex + colorChannel] = (pixels[pixelIndex + colorChannel] & 0xFE) | bit;
        bitIndex++;
    }

    // Encode data
    for (let i = 0; i < dataLength; i++) {
        const pixelIndex = Math.floor(bitIndex / 3) * 4;
        const colorChannel = bitIndex % 3;
        const bit = parseInt(binaryData[i]);
        pixels[pixelIndex + colorChannel] = (pixels[pixelIndex + colorChannel] & 0xFE) | bit;
        bitIndex++;
    }

    ctx.putImageData(imageData, 0, 0);
}


/**
 * Decodes data from an image's pixel data.
 * @param canvas The canvas containing the image.
 * @returns The decoded string, or null if no Scrimba data found.
 */
export function decodeDataFromCanvas(canvas: HTMLCanvasElement): string | null {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;

    let bitIndex = 0;
    let lengthBinary = '';

    // Read length (32 bits)
    for (let i = 0; i < 32; i++) {
        const pixelIndex = Math.floor(bitIndex / 3) * 4;
        const colorChannel = bitIndex % 3;
        lengthBinary += (pixels[pixelIndex + colorChannel] & 1).toString();
        bitIndex++;
    }

    const dataLength = parseInt(lengthBinary, 2);

    // Basic sanity check on length
    if (isNaN(dataLength) || dataLength <= 0 || dataLength > pixels.length * 3) {
        return null;
    }

    let binaryData = '';
    for (let i = 0; i < dataLength; i++) {
        const pixelIndex = Math.floor(bitIndex / 3) * 4;
        const colorChannel = bitIndex % 3;
        binaryData += (pixels[pixelIndex + colorChannel] & 1).toString();
        bitIndex++;
    }

    const decoded = binaryToString(binaryData);

    // V2: Compressed data
    if (decoded.startsWith(MAGIC_PREFIX)) {
        try {
            const base64Data = decoded.substring(MAGIC_PREFIX.length);
            const binaryString = atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const decompressed = pako.inflate(bytes, { to: 'string' });
            return decompressed;
        } catch (e) {
            console.error('Failed to decompress Scrimba data', e);
            return null;
        }
    }

    return null;
}



function stringToBinary(str: string): string {
    return str.split('').map(char => {
        return char.charCodeAt(0).toString(2).padStart(8, '0');
    }).join('');
}

function binaryToString(binary: string): string {
    const bytes = binary.match(/.{8}/g);
    if (!bytes) return '';
    return bytes.map(byte => String.fromCharCode(parseInt(byte, 2))).join('');
}
