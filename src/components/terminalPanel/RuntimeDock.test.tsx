import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  executionKindForLessonType,
  lessonSupportsTerminal,
  WORKSPACE_LESSON_TYPE_LABELS,
  type WorkspaceLessonType,
} from "../../types/workspace";

// Each panel is a stand-in that names itself; the panels have their own tests.
vi.mock("../TerminalPanel", () => ({ default: () => <p>Terminal</p> }));
vi.mock("../GoPlaygroundRunnerPanel", () => ({ default: () => <p>go-playground</p> }));
vi.mock("../KotlinPlaygroundRunnerPanel", () => ({ default: () => <p>kotlin-playground</p> }));
vi.mock("../RustPlaygroundRunnerPanel", () => ({ default: () => <p>rust-playground</p> }));
vi.mock("../ZigPlaygroundRunnerPanel", () => ({ default: () => <p>zig-playground</p> }));
vi.mock("../HaskellPlaygroundRunnerPanel", () => ({ default: () => <p>haskell-playground</p> }));
vi.mock("../KitePlaygroundRunnerPanel", () => ({ default: () => <p>kite-playground</p> }));
vi.mock("../AsmPlaygroundRunnerPanel", () => ({ default: () => <p>asm-playground</p> }));

import RuntimeDock from "./RuntimeDock";

const LESSON_TYPES = Object.keys(WORKSPACE_LESSON_TYPE_LABELS) as WorkspaceLessonType[];

describe("RuntimeDock", () => {
  // RuntimeDock decides by execution kind alone. That matches the terminal
  // capability only while every lesson type either runs in the WebContainer
  // or has a playground; a type with neither must be decided here first.
  it.each(LESSON_TYPES)(
    "offers the terminal for %s exactly when it runs in the WebContainer",
    (type) => {
      expect(lessonSupportsTerminal(type)).toBe(
        executionKindForLessonType(type) === "webcontainer",
      );
    },
  );

  it.each(LESSON_TYPES)("docks the runner for a %s lesson", async (lessonType) => {
    render(<RuntimeDock lessonType={lessonType} />);
    const expected = lessonSupportsTerminal(lessonType)
      ? "Terminal"
      : executionKindForLessonType(lessonType);
    // The asm panel is lazy, so wait for it rather than reading at once.
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it.each([
    ["html-css", "Terminal"],
    ["python", "Terminal"],
    ["kite-web", "Terminal"],
    ["go", "go-playground"],
    ["kite", "kite-playground"],
    ["asm", "asm-playground"],
  ] as const)("docks %s with the %s", async (lessonType, panel) => {
    render(<RuntimeDock lessonType={lessonType} />);
    expect(await screen.findByText(panel)).toBeInTheDocument();
  });
});
