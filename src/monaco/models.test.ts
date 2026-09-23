import { describe, expect, it } from "vite-plus/test";
// The monaco-editor package is mocked under test (vite.config.ts), so take Monaco's real
// URI class from its file: a model's path has to survive Monaco's own serialisation,
// which percent-encodes `$ + @ & = , ;` where encodeURI leaves them alone.
// @ts-expect-error -- Monaco publishes no types for its internal modules.
import { URI } from "../../node_modules/monaco-editor/esm/vs/base/common/uri.js";
import type { Monaco } from "./runtime";
import {
  acknowledgeWorkspaceModelContent,
  disposePlaybackModels,
  syncPlaybackModel,
  syncWorkspaceModel,
  toMonacoModelPath,
  toPlaybackModelPath,
  workspacePathFromMonacoModelUri,
} from "./models";

interface FakeUri {
  toString(): string;
}

interface FakeModel {
  uri: FakeUri;
  content: string;
  language: string;
  getValueCalls: number;
  setValueCalls: number;
  disposed: boolean;
  dispose(): void;
  getLanguageId(): string;
  getValue(): string;
  setValue(content: string): void;
}

function createFakeMonaco(
  parseUri: (value: string) => FakeUri = (value) => ({ toString: () => value }),
): { monaco: Monaco; models: Map<string, FakeModel> } {
  const models = new Map<string, FakeModel>();
  const monaco = {
    Uri: { parse: parseUri },
    editor: {
      getModel(uri: FakeUri): FakeModel | null {
        return models.get(uri.toString()) ?? null;
      },
      createModel(content: string, language: string, uri: FakeUri): FakeModel {
        const model: FakeModel = {
          uri,
          content,
          language,
          getValueCalls: 0,
          setValueCalls: 0,
          disposed: false,
          dispose: () => {
            model.disposed = true;
            models.delete(uri.toString());
          },
          getLanguageId: () => model.language,
          getValue: () => {
            model.getValueCalls += 1;
            return model.content;
          },
          setValue: (nextContent) => {
            model.setValueCalls += 1;
            model.content = nextContent;
          },
        };
        models.set(uri.toString(), model);
        return model;
      },
      setModelLanguage(model: FakeModel, language: string): void {
        model.language = language;
      },
      getModels: () => Array.from(models.values()),
    },
  } as unknown as Monaco;
  return { monaco, models };
}

describe("workspace Monaco model synchronization", () => {
  it("does not reread content already acknowledged by the workspace", () => {
    const { monaco, models } = createFakeMonaco();
    const model = syncWorkspaceModel(monaco, "src/App.tsx", "one", "typescript");
    const fakeModel = models.get(toMonacoModelPath("src/App.tsx"));
    if (!fakeModel) throw new Error("Expected fake model");

    syncWorkspaceModel(monaco, "src/App.tsx", "one", "typescript");
    expect(fakeModel.getValueCalls).toBe(0);

    fakeModel.content = "two";
    acknowledgeWorkspaceModelContent(model, "two");
    syncWorkspaceModel(monaco, "src/App.tsx", "two", "typescript");
    expect(fakeModel.getValueCalls).toBe(0);
    expect(fakeModel.setValueCalls).toBe(0);

    syncWorkspaceModel(monaco, "src/App.tsx", "remote", "typescript");
    expect(fakeModel.getValueCalls).toBe(1);
    expect(fakeModel.setValueCalls).toBe(1);
    expect(fakeModel.content).toBe("remote");
  });
});

describe("workspace model URIs", () => {
  it.each([
    "src/App.tsx",
    "src/routes/posts/$postId.tsx",
    "src/routes/+page.svelte",
    "src/@types/env.d.ts",
    "notes;v2 & more=1,2.md",
    "lesson #1?.md",
    "100%.css",
    "ü/😀.md",
  ])("maps the model created for %s back to that path", (path) => {
    const { monaco } = createFakeMonaco((value): FakeUri => URI.parse(value));
    const model = syncWorkspaceModel(monaco, path, "", "plaintext");

    expect(workspacePathFromMonacoModelUri(model.uri)).toBe(path);
  });

  it("keeps the active playback model when named by its playback path", () => {
    const { monaco } = createFakeMonaco((value): FakeUri => URI.parse(value));
    const path = "src/routes/posts/$postId.tsx";
    const active = syncPlaybackModel(monaco, path, "", "typescript") as unknown as FakeModel;
    const idle = syncPlaybackModel(
      monaco,
      "src/other.ts",
      "",
      "typescript",
    ) as unknown as FakeModel;

    disposePlaybackModels(monaco, toPlaybackModelPath(path));

    expect(active.disposed).toBe(false);
    expect(idle.disposed).toBe(true);
  });
});
