import { describe, expect, it } from "vite-plus/test";
import { LEXICON_V1, narrationLexiconFor, spokenFormOf } from "./lexicon";

describe("spokenFormOf", () => {
  it("replaces a listed term and keeps surrounding punctuation", () => {
    expect(spokenFormOf("Println(", LEXICON_V1)).toBe("print linn(");
    expect(spokenFormOf("(fmt)", LEXICON_V1)).toBe("(fumt)");
  });

  it("still replaces a term that ends a sentence", () => {
    // `.` belongs to the token core so qualified names stay one token, which
    // used to swallow the full stop and silently skip the entry — at exactly
    // the position narration puts a word most often.
    expect(spokenFormOf("fmt.", LEXICON_V1)).toBe("fumt.");
    expect(spokenFormOf("CSS.", LEXICON_V1)).toBe("C S S.");
    expect(spokenFormOf("HTML.", LEXICON_V1)).toBe("H T M L.");
  });

  it("spells out initialisms the voice would otherwise read as words", () => {
    expect(spokenFormOf("HTML", LEXICON_V1)).toBe("H T M L");
    expect(spokenFormOf("CSS", LEXICON_V1)).toBe("C S S");
    expect(spokenFormOf("CSS,", LEXICON_V1)).toBe("C S S,");
  });

  it("leaves a qualified name alone rather than matching its prefix", () => {
    // Trailing-stop recovery must not reach into a real qualified name.
    expect(spokenFormOf("fmt.Println", LEXICON_V1)).toBe("fmt.Println");
    expect(spokenFormOf("fmt.Println.", LEXICON_V1)).toBe("fmt.Println.");
  });

  it("leaves an unlisted token alone", () => {
    expect(spokenFormOf("ownership", LEXICON_V1)).toBe("ownership");
    expect(spokenFormOf(".", LEXICON_V1)).toBe(".");
  });

  it("does not resolve inherited Object properties as spoken forms", () => {
    // These are ordinary programming-lesson vocabulary. Indexing a plain object
    // literal returned Object.prototype members, which are non-nullish — so the
    // `??` fallback never fired and the narration ended up containing
    // "function Object() { [native code] }" in the audio and caption alignment.
    for (const token of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(spokenFormOf(token, LEXICON_V1)).toBe(token);
    }
  });
});

describe("narrationLexiconFor", () => {
  it("respells English narration and only the mispronounced terms in Burmese", () => {
    expect(narrationLexiconFor("en-US")).toBe(LEXICON_V1);
    const burmese = narrationLexiconFor("my-MM");
    // The English Pocket respellings never reach the Burmese voice.
    expect(spokenFormOf("HTML", burmese)).toBe("HTML");
    expect(spokenFormOf("struct", burmese)).toBe("struct");
    // Particles attach straight onto the term in Burmese; they stay put.
    expect(spokenFormOf("Viteက", burmese)).toBe("veetက");
    expect(spokenFormOf("vite", burmese)).toBe("veet");
    expect(spokenFormOf("DOM။", burmese)).toBe("Dom။");
    expect(spokenFormOf("className", burmese)).toBe("class name");
    expect(spokenFormOf("Appက", burmese)).toBe("Upက");
    expect(spokenFormOf("app", burmese)).toBe("up");
  });
});
