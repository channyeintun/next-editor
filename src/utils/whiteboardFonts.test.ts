import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface AddedFace {
  family: string;
  source: string;
  descriptors: FontFaceDescriptors;
}

// jsdom has no FontFace and no document.fonts, so both are stood in here.
let added: AddedFace[];

class FontFaceStub implements AddedFace {
  family: string;
  source: string;
  descriptors: FontFaceDescriptors;

  constructor(family: string, source: string, descriptors: FontFaceDescriptors) {
    this.family = family;
    this.source = source;
    this.descriptors = descriptors;
  }
}

beforeEach(() => {
  added = [];
  vi.resetModules();
  vi.stubGlobal("FontFace", FontFaceStub);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { add: (face: AddedFace) => added.push(face) },
  });
  delete window.EXCALIDRAW_ASSET_PATH;
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "fonts");
  delete window.EXCALIDRAW_ASSET_PATH;
});

describe("installWhiteboardFonts", () => {
  it("points Excalidraw at this app's copy of its fonts", async () => {
    const { installWhiteboardFonts } = await import("./whiteboardFonts");
    installWhiteboardFonts();
    expect(window.EXCALIDRAW_ASSET_PATH).toMatch(/^\/assets\/excalidraw-\d+\.\d+\.\d+\/$/);
  });

  it("adds the Myanmar face to every family Excalidraw loads as a web font", async () => {
    const { installWhiteboardFonts, MYANMAR_UNICODE_RANGE } = await import("./whiteboardFonts");
    installWhiteboardFonts();
    expect(added.map((face) => face.family).sort()).toEqual([
      "Cascadia",
      "Comic Shanns",
      "Excalifont",
      "Liberation Sans",
      "Lilita One",
      "Nunito",
      "Virgil",
    ]);
    for (const face of added) {
      expect(face.source).toMatch(
        /^url\(.*noto-sans-myanmar-myanmar-400-normal.*\) format\("woff2"\)$/,
      );
      expect(face.descriptors.unicodeRange).toBe(MYANMAR_UNICODE_RANGE);
    }
  });

  // A web face named like a system font hides that font: Helvetica text would
  // lose its Latin glyphs to the next family in the list.
  it("leaves the family taken from the viewer's system alone", async () => {
    const { installWhiteboardFonts } = await import("./whiteboardFonts");
    installWhiteboardFonts();
    expect(added.map((face) => face.family)).not.toContain("Helvetica");
  });

  // Text that only shares a joiner or a dotted circle with Burmese must not
  // fetch the face, or be drawn with it.
  it("covers the Myanmar blocks alone", async () => {
    const { MYANMAR_UNICODE_RANGE } = await import("./whiteboardFonts");
    expect(MYANMAR_UNICODE_RANGE).toBe("U+1000-109F, U+A9E0-A9FE, U+AA60-AA7F");
  });

  it("adds each face once, however often it is called", async () => {
    const { installWhiteboardFonts } = await import("./whiteboardFonts");
    installWhiteboardFonts();
    installWhiteboardFonts();
    expect(added).toHaveLength(7);
  });

  it("still sets the asset path where the browser has no FontFace", async () => {
    vi.stubGlobal("FontFace", undefined);
    const { installWhiteboardFonts } = await import("./whiteboardFonts");
    installWhiteboardFonts();
    expect(window.EXCALIDRAW_ASSET_PATH).toBeDefined();
    expect(added).toEqual([]);
  });
});
