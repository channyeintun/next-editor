// Pure-JS common-prefix/suffix length helpers. They narrow a text replacement
// to the part that changed for three callers: Monaco replay (`applyContentDiff`
// in editorDiff.ts), the workspace-event splice dedup in storage
// (workspaceEventDedup.ts), and the Yjs shared-text replacement in
// collaboration (projectDocument.ts). (They were once a fallback for a
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

/**
 * The common prefix and suffix lengths of `a` and `b`; the suffix is measured on
 * what follows the prefix, so the two never overlap. Both end on code point
 * boundaries.
 */
export function findCommonAffixLengths(a: string, b: string): { prefix: number; suffix: number } {
  const prefix = findCommonPrefixJS(a, b);
  return { prefix, suffix: findCommonSuffixJS(a.slice(prefix), b.slice(prefix)) };
}
