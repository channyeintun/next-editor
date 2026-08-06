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

/**
 * v1: terms that screen-reader-style TTS voices garble in code narration.
 *
 * The initialisms are spelled out letter by letter because the voice otherwise
 * tries to say them as words. They stay in v1 rather than opening a v2: no
 * existing lesson's narration contains them, so no recorded audio changes, and
 * bumping would invalidate the `lexiconVersion` stamped into every plan for a
 * difference nothing can hear.
 */
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
    HTML: "H T M L",
    CSS: "C S S",
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
  return `${prefix}${replacementFor(core, lexicon)}${suffix}`;
}

function replacementFor(core: string, lexicon: PronunciationLexicon): string {
  if (!core) {
    return core;
  }
  // Object.hasOwn, not `?? core`: `entries` is a plain object literal, so an
  // ordinary narration token like "constructor" (or "toString", "valueOf")
  // resolves through the prototype chain to a function, which is non-nullish —
  // so `??` never fired and the template above stringified it, splicing
  // "function Object() { [native code] }" into the TTS audio and the caption
  // alignment. No attacker needed; "constructor" is everyday lesson vocabulary.
  if (Object.hasOwn(lexicon.entries, core)) {
    return lexicon.entries[core];
  }
  // A `.` is part of the core because that is how qualified names are written
  // (`fmt.Println`), which also swallows the full stop of a token that ends a
  // sentence — so an entry silently stopped applying at exactly the position
  // where narration most often puts the word ("…beside HTML and CSS."). Retry
  // without the trailing stops and put them back afterwards; only tokens that
  // already missed can change, so no existing pronunciation moves.
  const trimmed = core.replace(/\.+$/, "");
  if (trimmed !== core && trimmed && Object.hasOwn(lexicon.entries, trimmed)) {
    return `${lexicon.entries[trimmed]}${core.slice(trimmed.length)}`;
  }
  return core;
}

/** Speech text for the TTS request: spoken forms joined in token order. */
export function speechTextOf(tokens: readonly string[], lexicon: PronunciationLexicon): string {
  return tokens.map((token) => spokenFormOf(token, lexicon)).join(" ");
}
