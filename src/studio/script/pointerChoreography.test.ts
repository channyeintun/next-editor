import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import {
  POINTER_AIM_MAX_MS,
  POINTER_PRESS_MS,
  POINTER_SETTLE_MS,
} from "../../core/src/utils/pointerMotion";
import { STUDIO_DOCK_TOGGLE_TARGET_ID } from "../targets";
import { CompileError } from "./errors";
import { planPointerChoreography, type PlacedAction } from "./pointerChoreography";
import { parseLessonScript, type LessonScript, type ScriptAction } from "./schema";

/** javascript-minimal: a WebContainer lesson whose dock opens expanded. */
function javascriptMinimal(): LessonScript {
  return parseLessonScript(
    YAML.parse(readFileSync(resolve(__dirname, "./__fixtures__/javascript-minimal.yaml"), "utf8")),
  );
}

/** go-cube: a Go Playground lesson opening main.go, with square.go beside it. */
function goCube(dockStartsCollapsed = false): LessonScript {
  const raw = YAML.parse(readFileSync(resolve(__dirname, "./__fixtures__/go-cube.yaml"), "utf8"));
  raw.runtime.dockStartsCollapsed = dockStartsCollapsed;
  return parseLessonScript(raw);
}

const LEAD_MS = 80;
const LONGEST_MOVE_MS = POINTER_SETTLE_MS + POINTER_PRESS_MS + POINTER_AIM_MAX_MS;
const at = { mark: "run", offsetMs: 0 };
const run: ScriptAction = { id: "run", type: "runtime.run", at, timeoutMs: 10_000 };
const openSquare: ScriptAction = {
  id: "open-square",
  type: "workspace.openFile",
  at,
  timeoutMs: 10_000,
  path: "square.go",
};
const typeCube: ScriptAction = {
  id: "type-cube",
  type: "editor.type",
  at,
  timeoutMs: 10_000,
  target: { file: "main.go", after: "", occurrence: 1 },
  cadence: "natural",
  text: "x",
};

const typeSquare: ScriptAction = {
  id: "type-square",
  type: "editor.type",
  at,
  timeoutMs: 10_000,
  target: { file: "square.go", after: "", occurrence: 1 },
  cadence: "natural",
  text: "x",
};
const selectSquare: ScriptAction = {
  id: "select-square",
  type: "editor.select",
  at,
  timeoutMs: 10_000,
  target: { file: "square.go", text: "value", occurrence: 1 },
};
const selectMain: ScriptAction = {
  id: "select-main",
  type: "editor.select",
  at,
  timeoutMs: 10_000,
  target: { file: "main.go", text: "main", occurrence: 1 },
};
const pointOutput: ScriptAction = {
  id: "point-output",
  type: "console.point",
  at,
  timeoutMs: 10_000,
  target: { text: "cubed", occurrence: 1 },
};
const expectOutput: ScriptAction = {
  id: "expect-output",
  type: "expect.output",
  at,
  timeoutMs: 10_000,
  contains: "cubed",
};

function choreograph(
  script: LessonScript,
  authored: PlacedAction[],
  busyMs = new Map<string, number>(),
) {
  return planPointerChoreography({ script, authored, busyMs });
}

describe("planPointerChoreography", () => {
  it("clicks a control once, releasing just before the action it performs", () => {
    const { cursorMoves, dockOpenings, warnings } = choreograph(goCube(), [
      { action: openSquare, at: 3_000 },
    ]);

    expect(cursorMoves).toEqual([
      {
        id: "cursor-open-square",
        at: 3_000 - LEAD_MS - LONGEST_MOVE_MS,
        target: { kind: "file", path: "square.go" },
        durationMs: LONGEST_MOVE_MS,
      },
    ]);
    expect(dockOpenings).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("opens a shut dock with its chevron, then presses Run", () => {
    const { cursorMoves, dockOpenings, warnings } = choreograph(goCube(true), [
      { action: run, at: 5_000 },
    ]);

    expect(cursorMoves.map((move) => move.target)).toEqual([
      { kind: "target-id", id: STUDIO_DOCK_TOGGLE_TARGET_ID },
      { kind: "run-button" },
    ]);
    const [chevron, runButton] = cursorMoves;
    // Run is pressed just before the run; the dock opens as that move starts,
    // just after the chevron click releases.
    expect(runButton.at + runButton.durationMs).toBe(5_000 - LEAD_MS);
    expect(dockOpenings).toEqual([{ id: "open-dock-run", at: runButton.at }]);
    expect(chevron.at + chevron.durationMs).toBe(runButton.at - LEAD_MS);
    expect(warnings).toEqual([]);
  });

  it("skips a click with no room after the previous typing ends, and says so", () => {
    const { cursorMoves, warnings } = choreograph(
      goCube(),
      [
        { action: typeCube, at: 1_000 },
        { action: openSquare, at: 3_000 },
      ],
      new Map([["type-cube", 1_900]]),
    );

    expect(cursorMoves).toEqual([]);
    expect(warnings).toEqual([
      expect.stringMatching(
        /^Skipped the pointer click before "open-square" — only 100ms clear before it/,
      ),
    ]);
  });

  // Only workspace.openFile changes the file on screen during a performance;
  // the driver refuses to edit any other one, so the render used to fail at
  // this action after the recording had started.
  it("rejects typing into or selecting in a file that is not open", () => {
    for (const edit of [typeSquare, selectSquare]) {
      const compile = () => choreograph(goCube(), [{ action: edit, at: 3_000 }]);
      expect(compile).toThrow(CompileError);
      expect(compile).toThrow(
        new RegExp(
          `^${edit.type} "${edit.id}" edits "square\\.go" while "main\\.go" is open — add a workspace\\.openFile of "square\\.go" before it$`,
        ),
      );
    }
  });

  it("accepts typing into and selecting in a file once it is open", () => {
    expect(() =>
      choreograph(goCube(), [
        { action: typeCube, at: 1_000 },
        { action: openSquare, at: 3_000 },
        { action: typeSquare, at: 5_000 },
        { action: selectSquare, at: 9_000 },
      ]),
    ).not.toThrow();
  });

  // With no run yet the console is empty, so the expectation waited out its
  // whole timeout and then failed the render.
  it("rejects an expect.output before the lesson's first run", () => {
    const compile = () =>
      choreograph(goCube(), [
        { action: expectOutput, at: 3_000 },
        { action: run, at: 5_000 },
      ]);
    expect(compile).toThrow(CompileError);
    expect(compile).toThrow(
      /^expect\.output "expect-output" comes before the lesson's first runtime\.run — there is no output on the console to check yet$/,
    );
  });

  it("accepts an expect.output after the lesson's first run", () => {
    expect(() =>
      choreograph(goCube(), [
        { action: run, at: 3_000 },
        { action: expectOutput, at: 5_000 },
      ]),
    ).not.toThrow();
  });

  // How much of the editor the open dock covers depends on the viewer's
  // screen, so a select clear of it on one display swept code hidden under it
  // on a shorter one.
  it("shuts an open dock with its chevron right before a select", () => {
    const { cursorMoves, dockClosings, warnings } = choreograph(goCube(), [
      { action: run, at: 1_000 },
      { action: selectMain, at: 5_000 },
    ]);

    expect(dockClosings).toEqual([
      { id: "collapse-dock-select-main", at: 5_000, beforeActionId: "select-main" },
    ]);
    const chevron = cursorMoves.find((move) => move.id === "cursor-collapse-dock-select-main");
    expect(chevron?.target).toEqual({ kind: "target-id", id: STUDIO_DOCK_TOGGLE_TARGET_ID });
    expect(chevron && chevron.at + chevron.durationMs).toBe(5_000 - LEAD_MS);
    expect(warnings).toEqual([]);
  });

  it("leaves a shut dock alone, and reopens one a select shut before the next run", () => {
    expect(choreograph(goCube(true), [{ action: selectMain, at: 5_000 }]).dockClosings).toEqual([]);

    const { dockOpenings } = choreograph(goCube(), [
      { action: selectMain, at: 3_000 },
      { action: run, at: 8_000 },
    ]);
    expect(dockOpenings).toEqual([{ id: "open-dock-run", at: expect.any(Number) }]);
  });

  it("shuts a WebContainer dock before a select without a click", () => {
    const select: ScriptAction = {
      ...selectMain,
      target: { file: "server.js", text: "createServer", occurrence: 1 },
    };
    const { cursorMoves, dockClosings } = choreograph(javascriptMinimal(), [
      { action: select, at: 5_000 },
    ]);

    expect(dockClosings.map((closing) => closing.id)).toEqual(["collapse-dock-select-main"]);
    expect(cursorMoves).toEqual([]);
  });

  it("rejects a console.point after a select has shut the dock", () => {
    const compile = () =>
      choreograph(goCube(), [
        { action: run, at: 1_000 },
        { action: selectMain, at: 5_000 },
        { action: pointOutput, at: 9_000 },
      ]);
    expect(compile).toThrow(
      /^console\.point "point-output" points at the console while the runner dock is shut/,
    );
  });
});
