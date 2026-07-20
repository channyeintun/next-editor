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
  const replacement = core ? (lexicon.entries[core] ?? core) : core;
  return `${prefix}${replacement}${suffix}`;
}

/** Speech text for the TTS request: spoken forms joined in token order. */
export function speechTextOf(tokens: readonly string[], lexicon: PronunciationLexicon): string {
  return tokens.map((token) => spokenFormOf(token, lexicon)).join(" ");
}
