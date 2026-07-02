import { describe, expect, it, vi } from "vite-plus/test";
import type * as monaco from "monaco-editor";
import type { MouseCursorPosition } from "../types";
import { createFrame } from "./editorMachineHelpers";

interface FakeEditorState {
  uri: string;
  versionId: number;
  value: string;
  scrollTop: number;
}

const makeEditor = (state: FakeEditorState) => {
  const getValue = vi.fn<() => string>(() => state.value);
  const saveViewState = vi.fn<() => null>(() => null);
  const editor = {
    getModel: () => ({
      getVersionId: () => state.versionId,
      uri: { toString: () => state.uri },
    }),
    getValue,
    getPosition: () => null,
    getSelection: () => null,
    getScrollTop: () => state.scrollTop,
    getScrollLeft: () => 0,
    saveViewState,
  } as unknown as monaco.editor.IStandaloneCodeEditor;
  return { editor, getValue, saveViewState, state };
};

const mouse: MouseCursorPosition = { x: 0, y: 0, visible: false };

describe("createFrame capture gating", () => {
  it("reuses content and viewState by reference when model, version, scroll and selection are unchanged", () => {
    const fake = makeEditor({ uri: "file:///a.ts", versionId: 5, value: "aaa", scrollTop: 0 });
    const first = createFrame(fake.editor, 0, mouse);

    const second = createFrame(
      fake.editor,
      50,
      mouse,
      undefined,
      undefined,
      {
        value: first.frame.state.content,
        versionId: first.contentVersionId,
        modelUri: first.modelUri,
      },
      first.viewStateRef,
    );

    expect(second.frame.state.content).toBe(first.frame.state.content);
    expect(fake.getValue).toHaveBeenCalledTimes(1);
    expect(fake.saveViewState).toHaveBeenCalledTimes(1);
    expect(second.frame.state.viewState).toBe(first.frame.state.viewState);
  });

  it("does not reuse content when the model changed, even if the per-model version id coincides", () => {
    const fake = makeEditor({ uri: "file:///a.ts", versionId: 5, value: "aaa", scrollTop: 0 });
    const first = createFrame(fake.editor, 0, mouse);

    // Simulate switching the active file: new model, same numeric version id.
    fake.state.uri = "file:///b.ts";
    fake.state.value = "bbb";

    const second = createFrame(
      fake.editor,
      50,
      mouse,
      undefined,
      undefined,
      {
        value: first.frame.state.content,
        versionId: first.contentVersionId,
        modelUri: first.modelUri,
      },
      first.viewStateRef,
    );

    expect(second.frame.state.content).toBe("bbb");
    expect(second.modelUri).toBe("file:///b.ts");
    expect(fake.saveViewState).toHaveBeenCalledTimes(2);
  });

  it("recomputes viewState when scroll changes but still reuses unchanged content", () => {
    const fake = makeEditor({ uri: "file:///a.ts", versionId: 5, value: "aaa", scrollTop: 0 });
    const first = createFrame(fake.editor, 0, mouse);

    fake.state.scrollTop = 120;

    const second = createFrame(
      fake.editor,
      50,
      mouse,
      undefined,
      undefined,
      {
        value: first.frame.state.content,
        versionId: first.contentVersionId,
        modelUri: first.modelUri,
      },
      first.viewStateRef,
    );

    expect(fake.saveViewState).toHaveBeenCalledTimes(2);
    expect(second.frame.state.content).toBe(first.frame.state.content);
    expect(fake.getValue).toHaveBeenCalledTimes(1);
  });
});
