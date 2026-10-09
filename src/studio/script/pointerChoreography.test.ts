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
import { planPointerChoreography, type PlacedAction } from "./pointerChoreography";
import { parseLessonScript, type LessonScript, type ScriptAction } from "./schema";

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
});
