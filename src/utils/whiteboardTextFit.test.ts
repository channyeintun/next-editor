import { describe, expect, it } from "vite-plus/test";
import type { WhiteboardElementJSON } from "../core/src/whiteboard";
import {
  excalidrawFontString,
  fitTextElement,
  type MeasureTextLine,
  withoutTextFit,
} from "./whiteboardTextFit";

// 20px per UTF-16 unit, whatever the font: wide enough to overflow the boxes below.
const measureWide: MeasureTextLine = (_font, line) => line.length * 20;

function text(overrides: Partial<WhiteboardElementJSON> = {}): WhiteboardElementJSON {
  return {
    id: "title",
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    type: "text",
    x: 290,
    y: 160,
    width: 100,
    height: 46,
    text: "Compound type က",
    fontSize: 36,
    fontFamily: 1,
    lineHeight: 1.25,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: true,
    ...overrides,
  };
}

describe("excalidrawFontString", () => {
  it("matches the font string Excalidraw draws each family with", () => {
    expect(excalidrawFontString(36, 1)).toBe("36px Virgil, Segoe UI Emoji");
    expect(excalidrawFontString(28, 5)).toBe("28px Excalifont, Xiaolai, Segoe UI Emoji");
    expect(excalidrawFontString(20, 7)).toBe("20px Lilita One, Segoe UI Emoji");
    expect(excalidrawFontString(20, 4)).toBe("20px Segoe UI Emoji");
  });
});

describe("fitTextElement", () => {
  it("widens left-aligned text to its measured glyphs without moving it", () => {
    const element = text();
    const fitted = fitTextElement(element, measureWide);

    expect(fitted).not.toBe(element);
    expect(fitted).toMatchObject({ x: 290, y: 160, width: "Compound type က".length * 20 });
    // The input is the store's (and the recording's) object: never changed.
    expect(element.width).toBe(100);
  });

  it("measures with the font Excalidraw draws the element with", () => {
    const fonts: string[] = [];
    fitTextElement(text(), (font, line) => {
      fonts.push(font);
      return line.length;
    });
    expect(fonts).toEqual(["36px Virgil, Segoe UI Emoji"]);
  });

  it("returns the element itself when its stored size already fits", () => {
    const element = text({ width: 1000 });
    expect(fitTextElement(element, measureWide)).toBe(element);
  });

  it("never shrinks a box that is wider than its text", () => {
    const fitted = fitTextElement(text({ width: 100, text: "a\nmuch longer line" }), measureWide);
    expect(fitted.width).toBe("much longer line".length * 20);
    const roomy = text({ width: 900, height: 10, text: "a\nb" });
    expect(fitTextElement(roomy, measureWide)).toMatchObject({ width: 900 });
  });

  it("grows the height to every line at the element's line height", () => {
    const fitted = fitTextElement(
      text({ width: 1000, height: 46, text: "one\ntwo\nthree" }),
      measureWide,
    );
    expect(fitted.height).toBe(36 * 1.25 * 3);
  });

  it("leaves text it cannot safely widen alone", () => {
    for (const element of [
      text({ containerId: "box" }),
      text({ textAlign: "justify" }),
      text({ autoResize: false }),
      text({ isDeleted: true }),
      text({ type: "rectangle" }),
      // Excalidraw rotates about the centre, so a wider box would move the glyphs.
      text({ angle: Math.PI / 2 }),
    ]) {
      expect(fitTextElement(element, measureWide)).toBe(element);
    }
  });

  it("keeps centred and right-aligned glyphs where they were", () => {
    const growth = "Compound type က".length * 20 - 100;
    expect(fitTextElement(text({ textAlign: "center" }), measureWide)).toMatchObject({
      x: 290 - growth / 2,
      width: 100 + growth,
    });
    expect(fitTextElement(text({ textAlign: "right" }), measureWide)).toMatchObject({
      x: 290 - growth,
      width: 100 + growth,
    });
  });

  it("leaves the element alone when nothing can measure text (no 2D canvas)", () => {
    const element = text();
    expect(fitTextElement(element, () => null)).toBe(element);
  });
});

describe("fitted copies and undo", () => {
  it("give a fitted copy a new versionNonce, the same one on every push", () => {
    const element = text();
    const first = fitTextElement(element, measureWide);
    const again = fitTextElement(text(), measureWide);
    expect(first.versionNonce).not.toBe(element.versionNonce);
    expect(again.versionNonce).toBe(first.versionNonce);
    expect(first.version).toBe(element.version);
  });
});

describe("withoutTextFit", () => {
  it("puts back text that differs from the scene only by its fit", () => {
    const stored = text();
    const fitted = fitTextElement(stored, measureWide);
    const other = { ...text(), id: "box", type: "rectangle" };

    const restored = withoutTextFit([stored, other], [fitted, other]);

    expect(restored).toEqual([stored, other]);
    expect(restored[0]).toBe(stored);
  });

  it("puts back centred text whose fit also moved it", () => {
    const stored = text({ textAlign: "center" });
    const fitted = fitTextElement(stored, measureWide);
    expect(fitted.x).not.toBe(stored.x);
    expect(withoutTextFit([stored], [fitted])[0]).toBe(stored);
    // Any other move of the same box is not a fit.
    const nudged = { ...fitted, x: (fitted.x as number) - 1 };
    expect(withoutTextFit([stored], [nudged])[0]).toBe(nudged);
  });

  it("returns the canvas array itself when nothing was fitted", () => {
    const elements = [text()];
    expect(withoutTextFit(elements, elements)).toBe(elements);
  });

  it("keeps a real edit of fitted text, even one that also grew the box", () => {
    const stored = text();
    const fitted = fitTextElement(stored, measureWide);
    const moved = { ...fitted, version: 2, x: 400 };
    const retyped = { ...fitted, text: "Compound type ကို" };

    expect(withoutTextFit([stored], [moved])[0]).toBe(moved);
    expect(withoutTextFit([stored], [retyped])[0]).toBe(retyped);
  });

  it("does not treat a smaller box or another element type as a fit", () => {
    const stored = text({ width: 300 });
    const shrunk = { ...stored, width: 200, versionNonce: 9 };
    const box = { ...text(), type: "rectangle" };
    const grownBox = { ...box, width: 500 };

    expect(withoutTextFit([stored], [shrunk])[0]).toBe(shrunk);
    expect(withoutTextFit([box], [grownBox])[0]).toBe(grownBox);
  });
});
