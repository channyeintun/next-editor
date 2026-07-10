import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

interface FakeModel {
  content: string;
  disposed: boolean;
  language: string;
  setValueCalls: string[];
  uri: { toString(): string };
  dispose(): void;
  getLanguageId(): string;
  getValue(): string;
  isDisposed(): boolean;
  setValue(content: string): void;
}

const fake = vi.hoisted(() => {
  const models = new Map<string, FakeModel>();
  let createCount = 0;

  interface FakeModel {
    content: string;
    disposed: boolean;
    language: string;
    setValueCalls: string[];
    uri: { toString(): string };
    dispose(): void;
    getLanguageId(): string;
    getValue(): string;
    isDisposed(): boolean;
    setValue(content: string): void;
  }

  const monaco = {
    Uri: {
      parse: (value: string) => ({ toString: () => value }),
    },
    editor: {
      getModel: (uri: { toString(): string }) => models.get(uri.toString()) ?? null,
      createModel(content: string, language: string, uri: { toString(): string }) {
        createCount += 1;
        const model: FakeModel = {
          content,
          disposed: false,
          language,
          setValueCalls: [],
          uri,
          dispose() {
            this.disposed = true;
            models.delete(uri.toString());
          },
          getLanguageId() {
            return this.language;
          },
          getValue() {
            return this.content;
          },
          isDisposed() {
            return this.disposed;
          },
          setValue(nextContent: string) {
            this.setValueCalls.push(nextContent);
            this.content = nextContent;
          },
        };
        models.set(uri.toString(), model);
        return model;
      },
      setModelLanguage(model: FakeModel, language: string) {
        model.language = language;
      },
    },
    reset() {
      models.clear();
      createCount = 0;
    },
    get createCount() {
      return createCount;
    },
    models,
  };

  return monaco;
});

vi.mock("./runtime", () => ({ monaco: fake }));

import { useOwnedModel } from "./useOwnedModel";

let latestModel: FakeModel | null = null;

function Probe({ uri, value, language }: { uri: string; value: string; language: string }) {
  latestModel = useOwnedModel({ uri, value, language }) as unknown as FakeModel | null;
  return null;
}

describe("useOwnedModel", () => {
  it("hands out a live model after StrictMode's effect replay", () => {
    fake.reset();
    latestModel = null;

    render(
      <StrictMode>
        <Probe uri="file:///__next-editor__/api-client/request.json" value="{}" language="json" />
      </StrictMode>,
    );

    // The replay must have disposed the first model and re-created it —
    // the returned model is the fresh, undisposed instance.
    expect(fake.createCount).toBe(2);
    expect(latestModel).not.toBeNull();
    expect(latestModel!.isDisposed()).toBe(false);
    expect(fake.models.size).toBe(1);
  });

  it("disposes the previous model and creates a new one when the URI changes", () => {
    fake.reset();
    latestModel = null;

    const { rerender } = render(<Probe uri="file:///a.json" value="a" language="json" />);
    const firstModel = latestModel!;

    rerender(<Probe uri="file:///b.json" value="b" language="json" />);

    expect(firstModel.isDisposed()).toBe(true);
    expect(latestModel!.uri.toString()).toBe("file:///b.json");
    expect(latestModel!.getValue()).toBe("b");
    expect(fake.models.size).toBe(1);
  });

  it("disposes the model on unmount", () => {
    fake.reset();
    latestModel = null;

    const { unmount } = render(<Probe uri="file:///a.json" value="a" language="json" />);
    const model = latestModel!;

    unmount();

    expect(model.isDisposed()).toBe(true);
    expect(fake.models.size).toBe(0);
  });

  it("only calls setValue and setModelLanguage when the props differ", () => {
    fake.reset();
    latestModel = null;

    const { rerender } = render(<Probe uri="file:///a.json" value="a" language="json" />);
    const model = latestModel!;

    expect(model.setValueCalls).toEqual([]);

    rerender(<Probe uri="file:///a.json" value="a" language="json" />);
    expect(model.setValueCalls).toEqual([]);
    expect(model.language).toBe("json");

    rerender(<Probe uri="file:///a.json" value="updated" language="plaintext" />);
    expect(model.setValueCalls).toEqual(["updated"]);
    expect(model.language).toBe("plaintext");
  });
});
