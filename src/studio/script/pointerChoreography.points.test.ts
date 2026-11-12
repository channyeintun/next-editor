import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import { CompileError } from "./errors";
import { planPointerChoreography, type PlacedAction } from "./pointerChoreography";
import { parseLessonScript, type LessonScript, type ScriptAction } from "./schema";

/** go-cube-tour: a Go Playground lesson that declares a slide and two whiteboard assets. */
function goCubeTour(): LessonScript {
  const raw = YAML.parse(
    readFileSync(resolve(__dirname, "./__fixtures__/go-cube-tour.yaml"), "utf8"),
  );
  // A third asset, declared but never drawn, gives the "not on the board" cases a target.
  raw.lesson.whiteboardAssets.push({
    id: "b",
    kind: "rectangle",
    x: 10,
    y: 10,
    width: 100,
    height: 50,
  });
  raw.lesson.whiteboardAssets.push({
    id: "a",
    kind: "rectangle",
    x: 200,
    y: 10,
    width: 100,
    height: 50,
  });
  return parseLessonScript(raw);
}

/** javascript-minimal: a WebContainer lesson, the only kind with a preview. */
function javascriptMinimal(): LessonScript {
  return parseLessonScript(
    YAML.parse(readFileSync(resolve(__dirname, "./__fixtures__/javascript-minimal.yaml"), "utf8")),
  );
}

const at = { mark: "board", offsetMs: 0 };

function apply(
  id: string,
  fields: { open?: boolean; upsertIds?: string[]; clear?: boolean },
): ScriptAction {
  return {
    id,
    type: "whiteboard.apply",
    at,
    timeoutMs: 10_000,
    upsertIds: fields.upsertIds ?? [],
    clear: fields.clear ?? false,
    drawMs: 0,
    ...(fields.open === undefined ? {} : { open: fields.open }),
  };
}

function pointBoard(id: string, assetId: string): ScriptAction {
  return { id, type: "whiteboard.point", at, timeoutMs: 10_000, target: { assetId } };
}

const pointSlide: ScriptAction = {
  id: "point-slide",
  type: "slide.point",
  at,
  timeoutMs: 10_000,
  target: { x: 0.25, y: 0.5 },
};
const showSlide: ScriptAction = {
  id: "show-slide",
  type: "slide.show",
  at,
  timeoutMs: 10_000,
  slideId: "intro",
  maximized: true,
};
const closeSlide: ScriptAction = { id: "close-slide", type: "slide.close", at, timeoutMs: 10_000 };
const pointPreview: ScriptAction = {
  id: "point-preview",
  type: "preview.point",
  at,
  timeoutMs: 10_000,
  target: { by: "testId", value: "title" },
};
const openPreview: ScriptAction = {
  id: "open-preview",
  type: "preview.open",
  at,
  timeoutMs: 10_000,
  mode: "docked",
  retry: { maxAttempts: 1, delayMs: 0 },
};

/** Places the actions one second apart, in order. */
function placed(...actions: ScriptAction[]): PlacedAction[] {
  return actions.map((action, index) => ({ action, at: 1_000 * (index + 1) }));
}

function choreograph(script: LessonScript, authored: PlacedAction[]) {
  return planPointerChoreography({ script, authored, busyMs: new Map() });
}

/** The CompileError `run` throws, or null when it throws nothing (anything else is rethrown). */
function compileErrorOf(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    if (error instanceof CompileError) return error.message;
    throw error;
  }
  return null;
}

describe("planPointerChoreography point targets", () => {
  it("rejects a whiteboard.point before any apply opens the board", () => {
    expect(compileErrorOf(() => choreograph(goCubeTour(), placed(pointBoard("p", "a"))))).toMatch(
      /while it is closed/,
    );
  });

  it("rejects a whiteboard.point at a declared asset that is not drawn", () => {
    expect(
      compileErrorOf(() =>
        choreograph(
          goCubeTour(),
          placed(apply("open", { open: true, upsertIds: ["a"] }), pointBoard("p", "b")),
        ),
      ),
    ).toMatch(/not on the board/);
  });

  it("follows clear: a wiped asset is gone, the one drawn after it is there", () => {
    const script = goCubeTour();
    const open = apply("open", { open: true, upsertIds: ["a"] });
    const wipe = apply("wipe", { clear: true, upsertIds: ["b"] });
    expect(() => choreograph(script, placed(open, pointBoard("p", "a")))).not.toThrow();
    expect(
      compileErrorOf(() => choreograph(script, placed(open, wipe, pointBoard("p", "a")))),
    ).toMatch(/not on the board/);
    expect(() => choreograph(script, placed(open, wipe, pointBoard("p", "b")))).not.toThrow();
  });

  it("rejects a point while the board is closed, and keeps its elements for a reopen", () => {
    const script = goCubeTour();
    const open = apply("open", { open: true, upsertIds: ["a"] });
    const close = apply("close", { open: false });
    expect(
      compileErrorOf(() => choreograph(script, placed(open, close, pointBoard("p", "a")))),
    ).toMatch(/while it is closed/);
    const reopen = apply("reopen", { open: true });
    expect(() =>
      choreograph(script, placed(open, close, reopen, pointBoard("p", "a"))),
    ).not.toThrow();
  });

  it("rejects a slide.point with no slide showing, before the show and after the close", () => {
    const script = goCubeTour();
    expect(compileErrorOf(() => choreograph(script, placed(pointSlide)))).toMatch(
      /none is showing/,
    );
    expect(() => choreograph(script, placed(showSlide, pointSlide))).not.toThrow();
    expect(
      compileErrorOf(() => choreograph(script, placed(showSlide, closeSlide, pointSlide))),
    ).toMatch(/none is showing/);
  });

  it("rejects a slide.point while the whiteboard is open over the slide", () => {
    expect(
      compileErrorOf(() =>
        choreograph(
          goCubeTour(),
          placed(showSlide, apply("open", { open: true, upsertIds: ["a"] }), pointSlide),
        ),
      ),
    ).toMatch(/whiteboard is open over it/);
  });

  it("rejects a preview.point before the preview opens", () => {
    const script = javascriptMinimal();
    expect(compileErrorOf(() => choreograph(script, placed(pointPreview)))).toMatch(
      /before the lesson's preview\.open/,
    );
    expect(() => choreograph(script, placed(openPreview, pointPreview))).not.toThrow();
  });

  // A point performs its own travel, so a derived click move before it would
  // be a second trip to the same spot.
  it("derives no cursor move for any point action", () => {
    const board = choreograph(
      goCubeTour(),
      placed(
        showSlide,
        pointSlide,
        closeSlide,
        apply("open", { open: true, upsertIds: ["a"] }),
        pointBoard("point-board", "a"),
      ),
    );
    const preview = choreograph(javascriptMinimal(), placed(openPreview, pointPreview));
    const ids = [...board.cursorMoves, ...preview.cursorMoves].map((move) => move.id);
    for (const pointId of ["point-slide", "point-board", "point-preview"]) {
      expect(ids.filter((id) => id.startsWith(`cursor-${pointId}`))).toEqual([]);
    }
  });
});
