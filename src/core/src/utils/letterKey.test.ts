import { describe, expect, it } from "vite-plus/test";
import { isLetterKey } from "./letterKey";

describe("isLetterKey", () => {
  const key = (init: Partial<KeyboardEvent>) => ({
    key: "s",
    code: "KeyS",
    altKey: false,
    ...init,
  });

  it("reads the letter the layout types, in either case", () => {
    expect(isLetterKey(key({}), "s")).toBe(true);
    expect(isLetterKey(key({ key: "S" }), "s")).toBe(true);
  });

  it("falls back to the physical key where the layout types no Latin letter", () => {
    expect(isLetterKey(key({ key: "ы" }), "s")).toBe(true);
    expect(isLetterKey(key({ key: "ပ", code: "KeyP" }), "p")).toBe(true);
    expect(isLetterKey(key({ key: "ы" }), "z")).toBe(false);
  });

  it("lets a Latin letter win over the physical key, so Dvorak and AZERTY keep theirs", () => {
    // Dvorak types s on the physical O.
    expect(isLetterKey(key({ key: "s", code: "KeyO" }), "s")).toBe(true);
    expect(isLetterKey(key({ key: "s", code: "KeyO" }), "o")).toBe(false);
    expect(isLetterKey(key({ key: "a", code: "KeyS" }), "s")).toBe(false);
  });

  it("leaves a character picked with AltGr or Option to the layout", () => {
    // Polish AltGr+S types ś; Windows reports it with Ctrl and Alt held.
    expect(isLetterKey(key({ key: "ś", altKey: true }), "s")).toBe(false);
    expect(isLetterKey(key({ key: "s", altKey: true }), "s")).toBe(true);
  });

  it("is false for keys that are not letters", () => {
    expect(isLetterKey(key({ key: "Control", code: "ControlLeft" }), "s")).toBe(false);
    expect(isLetterKey(key({ key: "/", code: "Slash" }), "s")).toBe(false);
  });
});
