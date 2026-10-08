import { describe, expect, it } from "vite-plus/test";
import { normalizeEditorFrame } from "./editorState";
import { isValidEditorState } from "./validation";

const state = normalizeEditorFrame({
  timestamp: 0,
  state: {
    content: "let a = 1;",
    selection: {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 4,
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 1,
      positionColumn: 4,
    },
    position: { lineNumber: 1, column: 4 },
    viewState: null,
  },
}).state;

describe("isValidEditorState", () => {
  it("accepts a normalized editor state", () => {
    expect(isValidEditorState(state)).toBe(true);
  });

  it("rejects content that is not a string", () => {
    for (const content of [42, {}, [], null, undefined]) {
      expect(isValidEditorState({ ...state, content })).toBe(false);
    }
  });

  it("rejects a state without a position or a selection", () => {
    expect(isValidEditorState({ ...state, position: undefined })).toBe(false);
    expect(isValidEditorState({ ...state, selection: undefined })).toBe(false);
  });

  it("rejects line and column values that are not finite", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isValidEditorState({ ...state, position: { lineNumber: value, column: 1 } })).toBe(
        false,
      );
      expect(
        isValidEditorState({ ...state, selection: { ...state.selection, endColumn: value } }),
      ).toBe(false);
    }
  });
});
