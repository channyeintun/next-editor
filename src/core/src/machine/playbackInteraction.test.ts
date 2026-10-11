import { describe, expect, it } from "vite-plus/test";
import { shouldPauseOnEditorKey } from "./playbackInteraction";

type Chord = Parameters<typeof shouldPauseOnEditorKey>[0];

const press = (key: string, modifiers: Partial<Omit<Chord, "key">> = {}): Chord => ({
  key,
  code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...modifiers,
});

describe("shouldPauseOnEditorKey", () => {
  // Copying, selecting all and finding change nothing in the file, so a learner can do
  // them while the lesson plays.
  it.each([
    ["Cmd+C", press("c", { metaKey: true })],
    ["Ctrl+C", press("c", { ctrlKey: true })],
    ["Cmd+A", press("a", { metaKey: true })],
    ["Ctrl+A", press("a", { ctrlKey: true })],
    ["Cmd+F", press("f", { metaKey: true })],
    ["Cmd+G", press("g", { metaKey: true })],
    ["Cmd+Shift+G", press("G", { metaKey: true })],
    // Layouts whose letter keys type no Latin letter keep the physical key's chord.
    ["Ctrl+C on a Greek layout", press("ψ", { ctrlKey: true, code: "KeyC" })],
    ["Ctrl+A on a Russian layout", press("ф", { ctrlKey: true, code: "KeyA" })],
  ])("keeps playing on %s", (_name, chord) => {
    expect(shouldPauseOnEditorKey(chord)).toBe(false);
  });

  it.each([
    ["ArrowLeft", press("ArrowLeft")],
    ["Meta", press("Meta", { metaKey: true })],
  ])("keeps playing on the navigation or modifier key %s", (_name, chord) => {
    expect(shouldPauseOnEditorKey(chord)).toBe(false);
  });

  // Anything that may change the text pauses, chords included.
  it.each([
    ["c", press("c")],
    ["Cmd+V", press("v", { metaKey: true })],
    ["Cmd+X", press("x", { metaKey: true })],
    ["Cmd+Z", press("z", { metaKey: true })],
    ["Cmd+/", press("/", { metaKey: true, code: "Slash" })],
    // AltGr: Windows reports it with Ctrl and Alt held, and it types a character.
    ["Ctrl+Alt+C", press("c", { ctrlKey: true, altKey: true })],
    ["ψ on a Greek layout", press("ψ", { code: "KeyC" })],
    ["Enter", press("Enter")],
    ["Backspace", press("Backspace")],
  ])("pauses on %s", (_name, chord) => {
    expect(shouldPauseOnEditorKey(chord)).toBe(true);
  });
});
