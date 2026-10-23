import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { loadEditorFonts } from "./editorFont";
import type { Monaco } from "./runtime";

interface StubFace {
  family: string;
  source: string;
  descriptors: FontFaceDescriptors;
  load: () => Promise<StubFace>;
}

function stubMonaco() {
  const remeasureFonts = vi.fn<() => void>();
  return { monaco: { editor: { remeasureFonts } } as unknown as Monaco, remeasureFonts };
}

// jsdom has neither FontFace nor document.fonts.
function stubFontApi({ failing = false } = {}) {
  const faces: StubFace[] = [];
  const fonts = {
    add: vi.fn<(face: StubFace) => void>((face) => faces.push(face)),
    load: vi.fn<(font: string, text?: string) => Promise<unknown>>(async () => []),
  };
  vi.stubGlobal(
    "FontFace",
    class {
      family: string;
      source: string;
      descriptors: FontFaceDescriptors;
      constructor(family: string, source: string, descriptors: FontFaceDescriptors) {
        this.family = family;
        this.source = source;
        this.descriptors = descriptors;
      }
      load = vi.fn<() => Promise<unknown>>(async () => {
        if (failing) throw new Error("network");
        return this;
      });
    },
  );
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  return { faces, fonts };
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "fonts");
});

describe("loadEditorFonts", () => {
  it("registers the three styles Monaco measures and loads them with the Burmese face", async () => {
    const { faces, fonts } = stubFontApi();
    const { monaco, remeasureFonts } = stubMonaco();

    await loadEditorFonts(monaco);

    expect(faces.map(({ family, descriptors }) => ({ family, ...descriptors }))).toEqual([
      { family: "Source Code Pro", display: "swap", weight: "400" },
      { family: "Source Code Pro", display: "swap", weight: "400", style: "italic" },
      { family: "Source Code Pro", display: "swap", weight: "700" },
    ]);
    for (const face of faces) {
      expect(face.source).toMatch(/^url\(.+\.woff2\) format\("woff2"\)$/);
      expect(face.load).toHaveBeenCalledOnce();
    }
    expect(fonts.load).toHaveBeenCalledWith('14px "Noto Sans Myanmar"', "က");
    expect(remeasureFonts).toHaveBeenCalledOnce();
  });

  it("still remeasures when a face fails, so Monaco measures the fallback it draws", async () => {
    stubFontApi({ failing: true });
    const { monaco, remeasureFonts } = stubMonaco();

    await expect(loadEditorFonts(monaco)).resolves.toBeUndefined();
    expect(remeasureFonts).toHaveBeenCalledOnce();
  });

  it("does nothing without a font loading API", async () => {
    const { monaco, remeasureFonts } = stubMonaco();

    await loadEditorFonts(monaco);

    expect(remeasureFonts).not.toHaveBeenCalled();
  });
});
