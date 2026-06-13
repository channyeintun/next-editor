import { describe, expect, it } from "vite-plus/test";
import type { Monaco } from "@monaco-editor/react";
import {
  disposePlaybackModels,
  syncPlaybackModel,
  toMonacoModelPath,
  toPlaybackModelPath,
  workspacePathFromMonacoModelUri,
} from "./editorModels";

interface FakeUri {
  toString(): string;
}

interface FakeModel {
  content: string;
  disposed: boolean;
  language: string;
  uri: FakeUri;
  dispose(): void;
  getValue(): string;
  setValue(content: string): void;
}

function createFakeMonaco() {
  const models = new Map<string, FakeModel>();

  const monaco = {
    Uri: {
      parse(value: string): FakeUri {
        return {
          toString: () => value,
        };
      },
    },
    editor: {
      getModel(uri: FakeUri) {
        return models.get(uri.toString()) ?? null;
      },
      createModel(content: string, language: string, uri: FakeUri) {
        const model: FakeModel = {
          content,
          disposed: false,
          language,
          uri,
          dispose() {
            this.disposed = true;
            models.delete(uri.toString());
          },
          getValue() {
            return this.content;
          },
          setValue(nextContent: string) {
            this.content = nextContent;
          },
        };

        models.set(uri.toString(), model);
        return model;
      },
      setModelLanguage(model: FakeModel, language: string) {
        model.language = language;
      },
      getModels() {
        return Array.from(models.values());
      },
    },
  };

  return {
    models,
    monaco: monaco as unknown as Monaco,
  };
}

describe("editor model helpers", () => {
  it("normalizes workspace paths into Monaco model URIs", () => {
    expect(toMonacoModelPath("/src//App.tsx")).toBe("file:///src/App.tsx");
    expect(toPlaybackModelPath("/src//App.tsx")).toBe(
      "file:///__next-editor__/playback/src/App.tsx",
    );
  });

  it("creates playback models with the replayed workspace snapshot content", () => {
    const { models, monaco } = createFakeMonaco();

    const model = syncPlaybackModel(
      monaco,
      "src/App.tsx",
      "export default function App() {}",
      "typescript",
    ) as unknown as FakeModel;

    expect(model.getValue()).toBe("export default function App() {}");
    expect(model.language).toBe("typescript");
    expect(models.size).toBe(1);
  });

  it("reconciles existing playback models to the active replay snapshot", () => {
    const { models, monaco } = createFakeMonaco();

    const firstModel = syncPlaybackModel(monaco, "src/App.tsx", "future content", "javascript");

    const secondModel = syncPlaybackModel(
      monaco,
      "src/App.tsx",
      "snapshot content",
      "typescript",
    ) as unknown as FakeModel;

    expect(secondModel).toBe(firstModel);
    expect(secondModel.getValue()).toBe("snapshot content");
    expect(secondModel.language).toBe("typescript");
    expect(models.size).toBe(1);
  });

  it("resolves normal Monaco model URIs back to workspace paths", () => {
    expect(
      workspacePathFromMonacoModelUri({
        toString: () => "file:///src/My%20Component.tsx",
      }),
    ).toBe("src/My Component.tsx");
  });

  it("does not resolve playback model URIs as writable workspace paths", () => {
    expect(
      workspacePathFromMonacoModelUri({
        toString: () => "file:///__next-editor__/playback/src/App.tsx",
      }),
    ).toBeNull();
  });

  it("disposes inactive playback models while preserving normal models", () => {
    const { models, monaco } = createFakeMonaco();
    const normalUri = monaco.Uri.parse(toMonacoModelPath("src/App.tsx"));
    const normalModel = monaco.editor.createModel(
      "workspace content",
      "typescript",
      normalUri,
    ) as unknown as FakeModel;
    const activePlaybackModel = syncPlaybackModel(
      monaco,
      "src/App.tsx",
      "active replay content",
      "typescript",
    ) as unknown as FakeModel;
    const stalePlaybackModel = syncPlaybackModel(
      monaco,
      "src/Old.tsx",
      "stale replay content",
      "typescript",
    ) as unknown as FakeModel;

    disposePlaybackModels(monaco, activePlaybackModel.uri);

    expect(normalModel.disposed).toBe(false);
    expect(activePlaybackModel.disposed).toBe(false);
    expect(stalePlaybackModel.disposed).toBe(true);
    expect(models.has(stalePlaybackModel.uri.toString())).toBe(false);

    disposePlaybackModels(monaco);

    expect(normalModel.disposed).toBe(false);
    expect(activePlaybackModel.disposed).toBe(true);
  });
});
