// Pure-JS common-prefix/suffix length helpers. The live editor diff
// (`applyContentDiff`) uses them to narrow the range it rewrites in Monaco, and
// `frameDelta.ts` wraps them as `findCommonPrefixLength` and
// `findCommonSuffixLength`. (They were once a fallback for a
// WebAssembly affix module; content deltas now come from the diff-match-patch
// codec instead, which does not use these helpers.)
//
// Lengths are in UTF-16 code units but never split a surrogate pair. An edit
// offset inside a pair is widened to the pair boundary by Monaco while the
// replacement text keeps its half pair, which corrupts astral characters such
// as emoji.

const isHighSurrogate = (charCode: number) => charCode >= 0xd800 && charCode <= 0xdbff;
const isLowSurrogate = (charCode: number) => charCode >= 0xdc00 && charCode <= 0xdfff;

/** Length of the common prefix shared by two strings, ending on a code point boundary. */
export function findCommonPrefixJS(str1: string, str2: string): number {
  const minLen = Math.min(str1.length, str2.length);
  let i = 0;
  while (i < minLen && str1[i] === str2[i]) i++;
  // Two astral characters can share a high surrogate; keep it with its low half.
  if (i > 0 && isHighSurrogate(str1.charCodeAt(i - 1))) i--;
  return i;
}

/** Length of the common suffix shared by two strings, starting on a code point boundary. */
export function findCommonSuffixJS(str1: string, str2: string): number {
  const minLen = Math.min(str1.length, str2.length);
  let i = 0;
  while (i < minLen && str1[str1.length - 1 - i] === str2[str2.length - 1 - i]) i++;
  // Two astral characters can share a low surrogate; keep it with its high half.
  if (i > 0 && isLowSurrogate(str1.charCodeAt(str1.length - i))) i--;
  return i;
}
