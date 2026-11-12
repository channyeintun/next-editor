import { describe, expect, it } from "vite-plus/test";
import type { StudioPlan } from "./plan";
import { PREVIEW_FIRST_LOAD_ROOM_MS, previewLoadRoom } from "./previewRoomLint";

type Actions = StudioPlan["actions"];

const base = { timeoutMs: 10_000 };
const retry = { maxAttempts: 1, delayMs: 0 };

const open = (at: number): Actions[number] => ({
  ...base,
  id: "open-preview",
  at,
  type: "preview.open",
  mode: "docked",
  retry,
});

const expectTitle = (at: number): Actions[number] => ({
  ...base,
  id: "expect-title",
  at,
  type: "expect.preview",
  route: "/",
  retry,
});

const collapse = (at: number): Actions[number] => ({
  ...base,
  id: "collapse-dock",
  at,
  type: "runtime.collapseDock",
});

const select = (at: number): Actions[number] => ({
  ...base,
  id: "select-state",
  at,
  type: "editor.select",
  path: "main.js",
  selection: { text: "let count = 0;", occurrence: 1 },
  durationMs: 800,
});

const dependencies = { "expect-title": "open-preview", "collapse-dock": "expect-title" };

describe("previewLoadRoom", () => {
  it("warns when the next narrated action is planned before a first load can finish", () => {
    const actions = [open(74_000), expectTitle(74_010), collapse(74_020), select(76_400)];
    expect(previewLoadRoom({ actions, dependencies })).toEqual([
      expect.stringMatching(
        /^preview\.open "open-preview" is followed 2\.4s later by editor\.select "select-state"/,
      ),
    ]);
  });

  it("passes over the chained actions and the expectations that wait for the load", () => {
    const actions = [
      open(70_000),
      expectTitle(70_010),
      collapse(70_020),
      select(70_000 + PREVIEW_FIRST_LOAD_ROOM_MS),
    ];
    expect(previewLoadRoom({ actions, dependencies })).toEqual([]);
  });

  it("has nothing to say about a plan with no preview, or with nothing after it", () => {
    expect(previewLoadRoom({ actions: [select(1_000)], dependencies: {} })).toEqual([]);
    expect(previewLoadRoom({ actions: [open(1_000), expectTitle(1_010)], dependencies })).toEqual(
      [],
    );
  });
});
