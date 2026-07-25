import { describe, expect, it } from "vitest";
import { LEXICON_V1, spokenFormOf } from "./lexicon";

describe("spokenFormOf", () => {
  it("replaces a listed term and keeps surrounding punctuation", () => {
    expect(spokenFormOf("Println(", LEXICON_V1)).toBe("print linn(");
    // `.` is part of the token core pattern, so "fmt." is not the "fmt" entry.
    expect(spokenFormOf("(fmt)", LEXICON_V1)).toBe("(fumt)");
  });

  it("leaves an unlisted token alone", () => {
    expect(spokenFormOf("ownership", LEXICON_V1)).toBe("ownership");
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
