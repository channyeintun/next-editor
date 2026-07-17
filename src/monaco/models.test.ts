import { describe, expect, it } from "vite-plus/test";
import type { Monaco } from "./runtime";
import { acknowledgeWorkspaceModelContent, syncWorkspaceModel, toMonacoModelPath } from "./models";

interface FakeUri {
  toString(): string;
}

interface FakeModel {
  uri: FakeUri;
  content: string;
  language: string;
  getValueCalls: number;
  setValueCalls: number;
  getLanguageId(): string;
  getValue(): string;
  setValue(content: string): void;
}

function createFakeMonaco(): { monaco: Monaco; models: Map<string, FakeModel> } {
  const models = new Map<string, FakeModel>();
  const monaco = {
    Uri: {
      parse(value: string): FakeUri {
        return { toString: () => value };
      },
    },
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
