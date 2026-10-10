import { describe, expect, it } from "vite-plus/test";
import {
  goToFileAriaKeyShortcuts,
  goToFileShortcutLabel,
  isGoToFileShortcut,
  isImeComposingKey,
} from "./goToFileShortcut";

const press = (init: Partial<KeyboardEvent>) => ({
  key: "p",
  code: "KeyP",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  keyCode: 80,
  ...init,
});

describe("isGoToFileShortcut", () => {
  it.each([
    ["Cmd+P on Apple", press({ metaKey: true }), true],
    ["Ctrl+P elsewhere", press({ ctrlKey: true }), false],
    ["Cmd+P with Caps Lock", press({ metaKey: true, key: "P" }), true],
    ["a non-Latin key on the physical P", press({ metaKey: true, key: "ပ" }), true],
  ])("takes %s", (_, event, isApple) => {
    expect(isGoToFileShortcut(event, isApple)).toBe(true);
  });

  it.each([
    ["Ctrl+P on Apple (Monaco's caret up)", press({ ctrlKey: true }), true],
    ["Meta+P elsewhere", press({ metaKey: true }), false],
    ["Cmd+Alt+P (find's Preserve Case)", press({ metaKey: true, altKey: true }), true],
    ["Cmd+Shift+P", press({ metaKey: true, shiftKey: true }), true],
    ["Cmd+Ctrl+P", press({ metaKey: true, ctrlKey: true }), true],
    ["Ctrl+Meta+P elsewhere", press({ metaKey: true, ctrlKey: true }), false],
    ["a key an input method is composing", press({ metaKey: true, isComposing: true }), true],
    ["keyCode 229", press({ metaKey: true, keyCode: 229 }), true],
    ["Dvorak's L on the physical P", press({ metaKey: true, key: "l" }), true],
    ["P alone", press({}), true],
    ["Cmd+/ (Monaco's toggle comment)", press({ metaKey: true, key: "/", code: "Slash" }), true],
    ["Ctrl+Enter elsewhere", press({ ctrlKey: true, key: "Enter", code: "Enter" }), false],
    ["a non-Latin key off the physical P", press({ metaKey: true, key: "က", code: "KeyU" }), true],
    ["Cmd pressed alone", press({ metaKey: true, key: "Meta", code: "MetaLeft" }), true],
  ])("leaves %s alone", (_, event, isApple) => {
    expect(isGoToFileShortcut(event, isApple)).toBe(false);
  });

  it("names the key for people and for assistive technology", () => {
    expect(goToFileShortcutLabel(true)).toBe("⌘P");
    expect(goToFileShortcutLabel(false)).toBe("Ctrl+P");
    expect(goToFileAriaKeyShortcuts(true)).toBe("Meta+P");
    expect(goToFileAriaKeyShortcuts(false)).toBe("Control+P");
  });
});

describe("isImeComposingKey", () => {
  it("is true while composing and for Safari's committing key, false otherwise", () => {
    expect(isImeComposingKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeComposingKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeComposingKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
