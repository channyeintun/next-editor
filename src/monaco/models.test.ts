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
  disposeRemovedWorkspaceModels,
  isPlaybackModelUri,
  syncPlaybackModel,
  syncWorkspaceModel,
  toInternalModelUri,
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
  attachedToEditor: boolean;
  dispose(): void;
  isAttachedToEditor(): boolean;
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
          attachedToEditor: false,
          isAttachedToEditor: () => model.attachedToEditor,
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

  // Workspace paths may be any name, including the one the editor once used as the
  // root of its own buffers; such a file used to become a playback model.
  it("keeps a workspace file under __next-editor__/ out of the editor's own buffers", () => {
    const { monaco } = createFakeMonaco((value): FakeUri => URI.parse(value));
    const path = "__next-editor__/playback/notes.md";
    const model = syncWorkspaceModel(monaco, path, "mine", "markdown") as unknown as FakeModel;

    expect(workspacePathFromMonacoModelUri(model.uri)).toBe(path);
    expect(isPlaybackModelUri(model.uri)).toBe(false);
    disposePlaybackModels(monaco);
    expect(model.disposed).toBe(false);

    // Nor does it take the API client's request-body buffer.
    syncWorkspaceModel(monaco, "__next-editor__/api-client/request-body.json", "{}", "json");
    expect(
      monaco.editor.getModel(URI.parse(toInternalModelUri("api-client/request-body.json"))),
    ).toBeNull();
  });
});

describe("disposeRemovedWorkspaceModels", () => {
  it("disposes only detached workspace models whose file left the project", () => {
    const { monaco } = createFakeMonaco((value): FakeUri => URI.parse(value));
    const create = (path: string) =>
      syncWorkspaceModel(monaco, path, "", "typescript") as unknown as FakeModel;
    const kept = create("src/kept.ts");
    const removed = create("src/removed.ts");
    const shown = create("src/shown-but-deleted.ts");
    shown.attachedToEditor = true;
    const bound = create("src/bound-but-deleted.ts");
    const playback = syncPlaybackModel(
      monaco,
      "src/removed.ts",
      "",
      "typescript",
    ) as unknown as FakeModel;
    const apiBody = monaco.editor.createModel(
      "{}",
      "json",
      URI.parse(toInternalModelUri("api-client/request-body.json")),
    ) as unknown as FakeModel;

    const disposed = disposeRemovedWorkspaceModels(monaco, { "src/kept.ts": {} }, [
      bound as never,
      null,
    ]);

    expect(disposed).toEqual([removed.uri.toString()]);
    expect(removed.disposed).toBe(true);
    // The file is still in the project.
    expect(kept.disposed).toBe(false);
    // An editor still shows it (CodeEditor keeps the active file's model attached).
    expect(shown.disposed).toBe(false);
    // The collaboration binding still holds it.
    expect(bound.disposed).toBe(false);
    // Not workspace models at all.
    expect(playback.disposed).toBe(false);
    expect(apiBody.disposed).toBe(false);
  });
});
