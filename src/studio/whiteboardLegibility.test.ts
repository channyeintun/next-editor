import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import { parseLessonScript, type LessonScript } from "./script/schema";
import { isPaleInk, whiteboardInkProblems, whiteboardLabelProblems } from "./whiteboardLegibility";

const FIXTURE_PATH = resolve(__dirname, "./script/__fixtures__/go-swap.yaml");

function scriptWithBoard(whiteboardAssets: Record<string, unknown>[]): LessonScript {
  const raw = YAML.parse(readFileSync(FIXTURE_PATH, "utf8"));
  raw.lesson.whiteboardAssets = whiteboardAssets;
  return parseLessonScript(raw);
}

const box = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "rectangle",
  x: 300,
  y: 200,
  width: 200,
  height: 100,
  ...extra,
});

describe("isPaleInk", () => {
  it("passes the default ink and the mid-tone palette", () => {
    const palette = ["#1e1e1e", "#1971c2", "#f08c00", "#2f9e44", "#e03131", "#6741d9"];
    expect(palette.filter(isPaleInk)).toEqual([]);
  });

  it("flags colours that invert to near-black on the dark board", () => {
    const pale = ["#e2e8f0", "#7dd3fc", "#ffffff", "#FFF"];
    expect(pale.filter((color) => !isPaleInk(color))).toEqual([]);
  });

  it("leaves colours it cannot read alone", () => {
    expect(isPaleInk("transparent")).toBe(false);
  });
});

describe("whiteboardInkProblems", () => {
  it("names each pale asset", () => {
    const script = scriptWithBoard([
      box("a", { strokeColor: "#e2e8f0" }),
      box("b", { strokeColor: "#1971c2" }),
    ]);
    expect(whiteboardInkProblems(script)).toEqual({ pale: ["a (#e2e8f0)"], oneShapeColour: false });
  });

  it("counts the default ink as a shape colour", () => {
    // An unset strokeColor paints #1e1e1e, so it differs from the blue box.
    const twoColours = scriptWithBoard([box("a"), box("b", { strokeColor: "#1971c2" })]);
    expect(whiteboardInkProblems(twoColours).oneShapeColour).toBe(false);
    const oneColour = scriptWithBoard([box("a"), box("b")]);
    expect(whiteboardInkProblems(oneColour).oneShapeColour).toBe(true);
  });

  it("has nothing to say about a lesson without a board", () => {
    expect(whiteboardInkProblems(scriptWithBoard([]))).toEqual({ pale: [], oneShapeColour: false });
  });
});

describe("whiteboardLabelProblems", () => {
  it("flags small labels and boxes outside the visible area", () => {
    const script = scriptWithBoard([
      {
        id: "small",
        kind: "text",
        text: "hi",
        x: 300,
        y: 200,
        width: 200,
        height: 40,
        fontSize: 20,
      },
      { id: "fine", kind: "text", text: "hi", x: 300, y: 300, width: 200, height: 40 },
      box("high", { y: 100 }),
    ]);
    expect(whiteboardLabelProblems(script)).toEqual({
      tooSmall: ["small @ 20px"],
      overflowing: [],
      offCanvas: ["high"],
    });
  });
});
