// The entry file of your WebAssembly module.
// Contains string diff functions.
// These exports compare UTF-8 bytes and return byte counts only.
// Callers converting results back to JS string offsets must clamp to code point boundaries.

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

