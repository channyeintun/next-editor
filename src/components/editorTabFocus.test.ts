import { describe, expect, it, vi } from "vite-plus/test";
// The monaco-editor package is mocked under test (vite.config.ts), so take Monaco's real
// context-key parser from its file: the precondition has to parse, and evaluate, as
// Monaco's keybinding service would.
// @ts-expect-error -- Monaco publishes no types for its internal modules.
import { ContextKeyExpr } from "../../node_modules/monaco-editor/esm/vs/platform/contextkey/common/contextkey.js";

// The real "../monaco" loads the whole editor; the action only needs Escape's key code.
vi.mock("../monaco", () => ({ monaco: { KeyCode: { Escape: 9 } } }));

const { addEscapeThenTabExit, TAB_MOVES_FOCUS_PRECONDITION } = await import("./editorTabFocus");

interface ActionDescriptor {
  id: string;
  keybindings?: number[];
  precondition?: string;
  run(editor: FakeEditor): void;
}

/** Just the editor surface the Escape-then-Tab exit touches. */
function createFakeEditor() {
  const blurListeners = new Set<() => void>();
  const disposeAction = vi.fn<() => void>();
  const editor = {
    actions: [] as ActionDescriptor[],
    disposeAction,
    addAction: vi.fn<(descriptor: ActionDescriptor) => { dispose(): void }>((descriptor) => {
      editor.actions.push(descriptor);
      return { dispose: disposeAction };
    }),
    onDidBlurEditorText(listener: () => void) {
      blurListeners.add(listener);
      return { dispose: () => blurListeners.delete(listener) };
    },
    blurText() {
      for (const listener of blurListeners) listener();
    },
    blurListenerCount: () => blurListeners.size,
    updateOptions: vi.fn<(options: Record<string, unknown>) => void>(),
  };
  return editor;
}
type FakeEditor = ReturnType<typeof createFakeEditor>;

function escapeIsFreeWith(context: Record<string, boolean>) {
  const expression = ContextKeyExpr.deserialize(TAB_MOVES_FOCUS_PRECONDITION);
  return expression.evaluate({ getValue: (key: string) => context[key] }) as boolean;
}

function mount() {
  const editor = createFakeEditor();
  const exit = addEscapeThenTabExit(editor as never);
  const [action] = editor.actions;
  return { editor, exit, action };
}

describe("addEscapeThenTabExit", () => {
  it("binds Escape to let Tab move focus out of the editor", () => {
    const { editor, action } = mount();

    expect(action.keybindings).toEqual([9]);
    action.run(editor);
    expect(editor.updateOptions).toHaveBeenLastCalledWith({ tabFocusMode: true });
  });

  it("lets Tab indent again once the editor text loses focus", () => {
    const { editor, action } = mount();
    action.run(editor);

    editor.blurText();
    expect(editor.updateOptions).toHaveBeenLastCalledWith({ tabFocusMode: false });
  });

  it("takes Escape only while the editor text is focused", () => {
    expect(escapeIsFreeWith({ editorTextFocus: true })).toBe(true);
    expect(escapeIsFreeWith({})).toBe(false);
  });

  it.each([
    "editorHasSelection",
    "editorHasMultipleSelections",
    "findWidgetVisible",
    "suggestWidgetVisible",
    "parameterHintsVisible",
    "renameInputVisible",
    "inSnippetMode",
    "markersNavigationVisible",
    "referenceSearchVisible",
    "messageVisible",
    "inlineSuggestionVisible",
  ])("leaves Escape to Monaco while %s", (owner) => {
    expect(escapeIsFreeWith({ editorTextFocus: true, [owner]: true })).toBe(false);
  });

  it("removes the action and the blur reset when disposed", () => {
    const { editor, exit } = mount();
    expect(editor.blurListenerCount()).toBe(1);

    exit.dispose();
    expect(editor.disposeAction).toHaveBeenCalledOnce();
    expect(editor.blurListenerCount()).toBe(0);
  });
});
