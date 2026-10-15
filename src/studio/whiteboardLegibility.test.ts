import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import { parseLessonScript, type LessonScript } from "./script/schema";
import { whiteboardLabelProblems } from "./whiteboardLegibility";

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
