// The entry file of your WebAssembly module.
// Contains LSB steganography and string diff functions.

// ============================================================
// STRING DIFF FUNCTIONS
// ============================================================

/**
 * Finds the length of common prefix between two byte arrays.
 * For UTF-8 strings, pass the encoded bytes.
 * 
 * @param str1Ptr Pointer to first string bytes
 * @param str1Len Length of first string
 * @param str2Ptr Pointer to second string bytes
 * @param str2Len Length of second string
 * @returns Length of common prefix in bytes
 */
export function findCommonPrefix(str1Ptr: usize, str1Len: i32, str2Ptr: usize, str2Len: i32): i32 {
  const minLen = min(str1Len, str2Len);
  let i: i32 = 0;

  // Process 8 bytes at a time for speed
  while (i + 8 <= minLen) {
    if (load<u64>(str1Ptr + i) != load<u64>(str2Ptr + i)) {
      // Found difference in this 8-byte chunk, find exact position
      while (i < minLen && load<u8>(str1Ptr + i) == load<u8>(str2Ptr + i)) {
        i++;
      }
      return i;
    }
    i += 8;
  }

  // Process remaining bytes
  while (i < minLen && load<u8>(str1Ptr + i) == load<u8>(str2Ptr + i)) {
    i++;
  }

  return i;
}

/**
 * Finds the length of common suffix between two byte arrays.
 * 
 * @param str1Ptr Pointer to first string bytes
 * @param str1Len Length of first string
 * @param str2Ptr Pointer to second string bytes
 * @param str2Len Length of second string
 * @returns Length of common suffix in bytes
 */
export function findCommonSuffix(str1Ptr: usize, str1Len: i32, str2Ptr: usize, str2Len: i32): i32 {
  const minLen = min(str1Len, str2Len);
  let i: i32 = 0;

  // Process byte by byte from the end
  while (i < minLen &&
    load<u8>(str1Ptr + str1Len - 1 - i) == load<u8>(str2Ptr + str2Len - 1 - i)) {
    i++;
  }

  return i;
}

// ============================================================
// BASE64 ENCODING/DECODING
// ============================================================


const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Encodes binary data to a Base64 string in Wasm memory.
 */
export function base64Encode(dataPtr: usize, dataLen: i32, outPtr: usize): i32 {
  let i: i32 = 0;
  let j: i32 = 0;

  while (i < dataLen) {
    const b0 = load<u8>(dataPtr + i++);
    const hasB1 = i < dataLen;
    const b1 = hasB1 ? load<u8>(dataPtr + i++) : 0;
    const hasB2 = i < dataLen;
    const b2 = hasB2 ? load<u8>(dataPtr + i++) : 0;

    const c0 = b0 >> 2;
    const c1 = ((b0 & 0x03) << 4) | (b1 >> 4);
    const c2 = ((b1 & 0x0F) << 2) | (b2 >> 6);
    const c3 = b2 & 0x3F;

    store<u8>(outPtr + j++, ALPHABET.charCodeAt(c0));
    store<u8>(outPtr + j++, ALPHABET.charCodeAt(c1));
    store<u8>(outPtr + j++, hasB1 ? ALPHABET.charCodeAt(c2) : 61); // '='
    store<u8>(outPtr + j++, hasB2 ? ALPHABET.charCodeAt(c3) : 61); // '='
  }

  return j;
}

// Global lookup table for decoding
const decoderLookup = new Uint8Array(256);
let isDecoderInitialized = false;

/**
 * Decodes a Base64 string from Wasm memory to binary data.
 */
export function base64Decode(strPtr: usize, strLen: i32, outPtr: usize): i32 {
  if (strLen == 0) return 0;

  if (!isDecoderInitialized) {
    // Initialize with 0xFF (invalid)
    for (let k = 0; k < 256; k++) {
      decoderLookup[k] = 0xFF;
    }
    for (let k = 0; k < 64; k++) {
      decoderLookup[ALPHABET.charCodeAt(k)] = k as u8;
    }
    isDecoderInitialized = true;
  }

  let i: i32 = 0;
  let j: i32 = 0;
  let buffer: u32 = 0;
  let bitsCollected: i32 = 0;

  while (i < strLen) {
    const char = load<u8>(strPtr + i++);

    // Skip '=' padding and whitespace/invalid chars
    if (char == 61) break; // Stop at first '='

    const val = decoderLookup[char];
    if (val == 0xFF) continue; // Skip invalid chars

    buffer = (buffer << 6) | (val as u32);
    bitsCollected += 6;

    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      store<u8>(outPtr + j++, (buffer >> bitsCollected) as u8);
    }
  }

  return j;
}

// ============================================================
// LSB STEGANOGRAPHY
// ============================================================

/**
 * Encodes data into pixels using LSB steganography.
 * 
 * @param pixelsPtr Pointer to the pixel data (Uint8ClampedArray/Uint8Array)
 * @param pixelsLen Length of the pixel data
 * @param dataPtr Pointer to the data to encode
 * @param dataLen Length of the data to encode
 */
export function encodeLSB(pixelsPtr: usize, pixelsLen: i32, dataPtr: usize, dataLen: i32): void {
  let bitIndex: i32 = 0;
  const totalBits: u32 = (dataLen as u32) * 8;

  // 1. Encode 32-bit length header (total bits)
  for (let i: i32 = 31; i >= 0; i--) {
    const bit = (totalBits >> i) & 1;
    const pixelIndex = (bitIndex / 3 | 0) * 4;
    const colorChannel = bitIndex % 3;
    const addr = pixelsPtr + (pixelIndex + colorChannel);

    // Safety check
    if (pixelIndex + colorChannel >= pixelsLen) return;

    const val = load<u8>(addr);
    store<u8>(addr, (val & 0xFE) | (bit as u8));
    bitIndex++;
  }

  // 2. Encode actual data bits
  for (let i: i32 = 0; i < dataLen; i++) {
    const byteVal = load<u8>(dataPtr + i);
    for (let bitPos: i32 = 7; bitPos >= 0; bitPos--) {
      const bit = (byteVal >> (bitPos as u8)) & 1;
      const pixelIndex = (bitIndex / 3 | 0) * 4;
      const colorChannel = bitIndex % 3;
      const addr = pixelsPtr + (pixelIndex + colorChannel);

      // Safety check
      if (pixelIndex + colorChannel >= pixelsLen) return;

      const val = load<u8>(addr);
      store<u8>(addr, (val & 0xFE) | (bit as u8));
      bitIndex++;
    }
  }
}

/**
 * Decodes data from pixels using LSB steganography.
 * 
 * @param pixelsPtr Pointer to the pixel data
 * @param pixelsLen Length of the pixel data
 * @param resultPtr Pointer to the buffer where decoded data will be stored
 * @param resultMaxLen Maximum capacity of the result buffer
 * @returns The length of the decoded data, or a negative error code
 */
export function decodeLSB(pixelsPtr: usize, pixelsLen: i32, resultPtr: usize, resultMaxLen: i32): i32 {
  let bitIndex: i32 = 0;
  let totalBits: u32 = 0;

  // 1. Read 32-bit length header
  for (let i: i32 = 0; i < 32; i++) {
    const pixelIndex = (bitIndex / 3 | 0) * 4;
    const colorChannel = bitIndex % 3;
    const addr = pixelsPtr + (pixelIndex + colorChannel);

    // Safety check
    if (pixelIndex + colorChannel >= pixelsLen) return -3;

    const bit = (load<u8>(addr) & 1) as u32;
    totalBits = (totalBits << 1) | bit;
    bitIndex++;
  }

  // Sanity check
  if (totalBits == 0 || totalBits > (pixelsLen as u32) * 3) {
    return -1;
  }

  const byteCount = totalBits / 8;
  if (byteCount > (resultMaxLen as u32)) {
    return -2;
  }

  // 2. Read data bits and reconstruct bytes
  for (let i: i32 = 0; i < (byteCount as i32); i++) {
    let byte: u8 = 0;
    for (let bitPos: i32 = 0; bitPos < 8; bitPos++) {
      const pixelIndex = (bitIndex / 3 | 0) * 4;
      const colorChannel = bitIndex % 3;
      const addr = pixelsPtr + (pixelIndex + colorChannel);

      // Safety check
      if (pixelIndex + colorChannel >= pixelsLen) return -3;

      const bit = (load<u8>(addr) & 1) as u8;
      byte = (byte << 1) | bit;
      bitIndex++;
    }
    store<u8>(resultPtr + i, byte);
  }

  return byteCount as i32;
}
