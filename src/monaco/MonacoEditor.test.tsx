import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { monaco } from "./runtime";

type EditorOptions = Record<string, unknown> & { model?: FakeModel | null };

interface FakeEditor {
  appliedOptions: EditorOptions[];
  disposed: boolean;
  layoutCount: number;
  model: FakeModel | null;
  dispose(): void;
  getModel(): FakeModel | null;
  getValue(): string;
  layout(): void;
  onDidChangeModelContent(listener: () => void): { dispose(): void };
  setModel(model: FakeModel | null): void;
  updateOptions(options: EditorOptions): void;
}

interface FakeModel {
  disposed: boolean;
  uri: { toString(): string };
  isDisposed(): boolean;
}

const fake = vi.hoisted(() => {
  interface FakeModel {
    disposed: boolean;
    uri: { toString(): string };
    isDisposed(): boolean;
  }

  type EditorOptions = Record<string, unknown> & { model?: FakeModel | null };

  const editors: ReturnType<typeof createFakeEditor>[] = [];

  function createFakeEditor(options: EditorOptions) {
    const editor = {
      appliedOptions: [options] as EditorOptions[],
      disposed: false,
      layoutCount: 0,
      model: options.model ?? null,
      dispose() {
        editor.disposed = true;
      },
      getModel() {
        return editor.model;
      },
      getValue() {
        return "";
      },
      layout() {
        editor.layoutCount += 1;
      },
      onDidChangeModelContent() {
        return { dispose() {} };
      },
      setModel(model: FakeModel | null) {
        editor.model = model;
      },
      updateOptions(options: EditorOptions) {
        editor.appliedOptions.push(options);
      },
    };
    return editor;
  }

  const monaco = {
    editor: {
      create: (_container: HTMLElement, options: EditorOptions) => {
        const editor = createFakeEditor(options);
        editors.push(editor);
        return editor;
      },
    },
    editors,
    reset() {
      editors.length = 0;
    },
  };

  return monaco;
});

vi.mock("./runtime", () => ({ monaco: fake }));

import { MonacoEditor } from "./MonacoEditor";

function createFakeModel(uri: string): FakeModel {
  return {
    disposed: false,
    uri: { toString: () => uri },
    isDisposed() {
      return this.disposed;
    },
  };
}

function asModel(model: FakeModel | null) {
  return model as unknown as monaco.editor.ITextModel | null;
}

describe("MonacoEditor", () => {
  it("recreates the editor under StrictMode's effect replay without touching the model", () => {
    fake.reset();
    const model = createFakeModel("file:///a.ts");

    render(
      <StrictMode>
        <MonacoEditor model={asModel(model)} />
      </StrictMode>,
    );

    expect(fake.editors).toHaveLength(2);
    expect(fake.editors[0].disposed).toBe(true);
    expect(fake.editors[1].disposed).toBe(false);
    expect(fake.editors[1].getModel()).toBe(model);
    // The component never disposes a model it's given.
    expect(model.disposed).toBe(false);
  });

  it("forces automaticLayout: false at creation and on every updateOptions", () => {
    fake.reset();
    const model = createFakeModel("file:///a.ts");

    const { rerender } = render(
      <MonacoEditor model={asModel(model)} options={{ automaticLayout: true }} />,
    );
    rerender(
      <MonacoEditor model={asModel(model)} options={{ automaticLayout: true, fontSize: 13 }} />,
    );

    const editor = fake.editors[0];
    expect(editor.appliedOptions.length).toBeGreaterThanOrEqual(2);
    editor.appliedOptions.forEach((options) => {
      expect(options.automaticLayout).toBe(false);
    });
  });

  it("calls onBeforeModelChange/onAfterModelChange around setModel exactly once per model change", () => {
    fake.reset();
    const modelA = createFakeModel("file:///a.ts");
    const modelB = createFakeModel("file:///b.ts");
    const calls: string[] = [];

    const { rerender } = render(
      <MonacoEditor
        model={asModel(modelA)}
        onBeforeModelChange={(editor) => {
          calls.push(
            `before:${(editor.getModel() as unknown as FakeModel | null)?.uri.toString()}`,
          );
        }}
        onAfterModelChange={(_editor, next) => {
          calls.push(`after:${(next as unknown as FakeModel | null)?.uri.toString()}`);
        }}
      />,
    );

    expect(calls).toEqual([]);

    rerender(
      <MonacoEditor
        model={asModel(modelB)}
        onBeforeModelChange={(editor) => {
          calls.push(
            `before:${(editor.getModel() as unknown as FakeModel | null)?.uri.toString()}`,
          );
        }}
        onAfterModelChange={(_editor, next) => {
          calls.push(`after:${(next as unknown as FakeModel | null)?.uri.toString()}`);
        }}
      />,
    );

    expect(calls).toEqual(["before:file:///a.ts", "after:file:///b.ts"]);
    expect(fake.editors[0].getModel()).toBe(modelB);
  });

  it("attaches null instead of a disposed model", () => {
    fake.reset();
    const disposedModel = createFakeModel("file:///stale.ts");
    disposedModel.disposed = true;

    render(<MonacoEditor model={asModel(disposedModel)} />);

    expect(fake.editors[0].appliedOptions[0].model).toBeNull();
    expect(fake.editors[0].getModel()).toBeNull();
  });

  it("fires onWillDispose with the editor still live, before disposal", () => {
    fake.reset();
    const model = createFakeModel("file:///a.ts");
    let liveAtCallback: boolean | null = null;
    let modelAtCallback: FakeModel | null = null;

    const { unmount } = render(
      <MonacoEditor
        model={asModel(model)}
        onWillDispose={(editor, currentModel) => {
          liveAtCallback = !(editor as unknown as FakeEditor).disposed;
          modelAtCallback = currentModel as unknown as FakeModel | null;
        }}
      />,
    );

    unmount();

    expect(liveAtCallback).toBe(true);
    expect(modelAtCallback).toBe(model);
    expect(fake.editors[0].disposed).toBe(true);
  });
});
