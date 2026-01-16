// The entry file of your WebAssembly module.

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
      const bit = (load<u8>(addr) & 1) as u8;
      byte = (byte << 1) | bit;
      bitIndex++;
    }
    store<u8>(resultPtr + i, byte);
  }

  return byteCount as i32;
}
