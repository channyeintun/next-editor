import { monaco } from "../monaco";

type StandaloneEditor = monaco.editor.IStandaloneCodeEditor;

/**
 * Monaco context keys under which Escape already does something in the
 * editor: cancel a selection or extra cursors, or close find, suggest,
 * parameter hints, rename, a snippet, the error and references peeks, an
 * inline message, an inline suggestion or the paste/drop widgets. A keybinding
 * added with `editor.addAction` outranks every built-in one, so the
 * Escape-then-Tab action stands aside whenever one of these is set.
 */
const CONTEXTS_THAT_OWN_ESCAPE = [
  "editorHasSelection",
  "editorHasMultipleSelections",
  "findWidgetVisible",
  "suggestWidgetVisible",
  "parameterHintsVisible",
  "renameInputVisible",
  "inSnippetMode",
  "markersNavigationVisible",
  "referenceSearchVisible",
  "hasSymbols",
  "messageVisible",
  "cancellableOperation",
  "selectionAnchorSet",
  "LinkedEditingInputVisible",
  "inlineSuggestionVisible",
  "inlineEditIsVisible",
  "pasteWidgetVisible",
  "dropWidgetVisible",
  "standaloneColorPickerVisible",
] as const;

export const TAB_MOVES_FOCUS_PRECONDITION = [
  "editorTextFocus",
  ...CONTEXTS_THAT_OWN_ESCAPE.map((key) => `!${key}`),
].join(" && ");

/** How to leave the editor by keyboard, for the end of its accessible name. */
export const LEAVE_EDITOR_HINT = "Press Escape, then Tab, to leave.";

/**
 * In a writable Monaco editor Tab types a tab and Shift+Tab outdents, so
 * neither leaves it. This makes Escape switch the editor to "Tab moves focus"
 * until its text loses focus, when Tab goes back to indenting. Returns the
 * disposable that removes the action and the reset again.
 */
export function addEscapeThenTabExit(editor: StandaloneEditor): { dispose(): void } {
  const action = editor.addAction({
    id: "next-editor.tabMovesFocus",
    label: "Let Tab move focus out of the editor",
    keybindings: [monaco.KeyCode.Escape],
    precondition: TAB_MOVES_FOCUS_PRECONDITION,
    run: (target) => {
      target.updateOptions({ tabFocusMode: true });
    },
  });
  const resetOnBlur = editor.onDidBlurEditorText(() => {
    editor.updateOptions({ tabFocusMode: false });
  });
  return {
    dispose: () => {
      action.dispose();
      resetOnBlur.dispose();
    },
  };
}
