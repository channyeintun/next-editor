// Pure-JS common-prefix/suffix length helpers, shared by both the frame-delta
// encoder and the editor diff so the two paths stay in sync. (These were once a
// fallback for a WebAssembly affix module; that module was removed when the
// recording codec moved to the Go zstd/go-diff WASM, so these are now the sole
// implementation.)

/** Length of the common prefix shared by two strings. */
export function findCommonPrefixJS(str1: string, str2: string): number {
  const minLen = Math.min(str1.length, str2.length);
  let i = 0;
  while (i < minLen && str1[i] === str2[i]) i++;
  return i;
}

/** Length of the common suffix shared by two strings. */
export function findCommonSuffixJS(str1: string, str2: string): number {
  const minLen = Math.min(str1.length, str2.length);
  let i = 0;
  while (i < minLen && str1[str1.length - 1 - i] === str2[str2.length - 1 - i]) i++;
  return i;
}
