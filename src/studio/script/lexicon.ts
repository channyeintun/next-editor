/**
 * Versioned pronunciation lexicon (docs/agent-lesson-production.md §6):
 * applied to the speech text handed to the TTS provider, never to the display
 * text captions render. Replacement is per display token (punctuation
 * preserved), so each display token maps to one spoken phrase and the
 * token-level alignment stays 1:1.
 */

export interface PronunciationLexicon {
  version: number;
  /** Case-sensitive display token (without surrounding punctuation) → spoken form. */
  entries: Record<string, string>;
}

/** v1: terms that screen-reader-style TTS voices garble in code narration. */
export const LEXICON_V1: PronunciationLexicon = {
  version: 1,
  entries: {
    Println: "print linn",
    Printf: "print eff",
    fmt: "fumt",
    int: "int",
    func: "funk",
    goroutine: "go routine",
    struct: "struckt",
  },
};

const TOKEN_CORE_PATTERN = /^([^A-Za-z0-9]*)([A-Za-z0-9][A-Za-z0-9._-]*)?([^A-Za-z0-9]*)$/;

/** Spoken form of one display token: lexicon applied to its core, punctuation kept. */
export function spokenFormOf(token: string, lexicon: PronunciationLexicon): string {
  const match = TOKEN_CORE_PATTERN.exec(token);
  if (!match) {
    return token;
  }
  const [, prefix = "", core = "", suffix = ""] = match;
  // Object.hasOwn, not `?? core`: `entries` is a plain object literal, so an
  // ordinary narration token like "constructor" (or "toString", "valueOf")
  // resolves through the prototype chain to a function, which is non-nullish —
  // so `??` never fired and the template below stringified it, splicing
  // "function Object() { [native code] }" into the TTS audio and the caption
  // alignment. No attacker needed; "constructor" is everyday lesson vocabulary.
  const replacement = core && Object.hasOwn(lexicon.entries, core) ? lexicon.entries[core] : core;
  return `${prefix}${replacement}${suffix}`;
}

/** Speech text for the TTS request: spoken forms joined in token order. */
export function speechTextOf(tokens: readonly string[], lexicon: PronunciationLexicon): string {
  return tokens.map((token) => spokenFormOf(token, lexicon)).join(" ");
}
