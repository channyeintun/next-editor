import { describe, expect, it } from "vitest";
import {
  executionKindForLessonType,
  inferLanguageFromPath,
  lessonRunsInWebContainer,
  lessonSupportsCodeRun,
  lessonSupportsPreview,
  lessonSupportsTerminal,
  type WorkspaceExecutionKind,
  type WorkspaceLessonType,
} from "./workspace";
import { normalizeProject } from "../stores/workspaceProjectSupport";
import { createStarterGoWorkspace } from "../starters/go";

// Record keys make this exhaustive at compile time: adding a lesson type
// without deciding its execution backend fails the typecheck, not just a test.
const EXPECTED_EXECUTION_KIND: Record<WorkspaceLessonType, WorkspaceExecutionKind> = {
  "html-css": "webcontainer",
  react: "webcontainer",
  vue: "webcontainer",
  solid: "webcontainer",
  svelte: "webcontainer",
  "htmx-express": "webcontainer",
  "alpine-express": "webcontainer",
  "express-ts": "webcontainer",
  go: "go-playground",
};

const ALL_LESSON_TYPES = Object.keys(EXPECTED_EXECUTION_KIND) as WorkspaceLessonType[];

describe("execution selection", () => {
  it.each(ALL_LESSON_TYPES)("selects the right backend for %s", (lessonType) => {
    expect(executionKindForLessonType(lessonType)).toBe(EXPECTED_EXECUTION_KIND[lessonType]);
  });

  it("keeps go out of the WebContainer set without touching existing types", () => {
    for (const lessonType of ALL_LESSON_TYPES) {
      expect(lessonRunsInWebContainer(lessonType)).toBe(lessonType !== "go");
    }
  });
});

describe("lesson capabilities", () => {
  it("gives go lessons Run without Terminal or Preview", () => {
    expect(lessonSupportsCodeRun("go")).toBe(true);
    expect(lessonSupportsTerminal("go")).toBe(false);
    expect(lessonSupportsPreview("go")).toBe(false);
  });

  it("keeps every WebContainer lesson's capabilities unchanged", () => {
    for (const lessonType of ALL_LESSON_TYPES.filter((type) => type !== "go")) {
      expect(lessonSupportsCodeRun(lessonType)).toBe(true);
      expect(lessonSupportsTerminal(lessonType)).toBe(true);
      expect(lessonSupportsPreview(lessonType)).toBe(true);
    }
  });
});

describe("go workspace model", () => {
  it("maps .go files to Monaco's go language id", () => {
    expect(inferLanguageFromPath("main.go")).toBe("go");
    expect(inferLanguageFromPath("cmd/tool/main.go")).toBe("go");
  });

  it("round-trips a go starter through project normalization without falling back", () => {
    const starter = createStarterGoWorkspace();
    const normalized = normalizeProject(starter);

    expect(normalized.lessonType).toBe("go");
    expect(normalized.entryFilePath).toBe("main.go");
    expect(normalized.files["main.go"].language).toBe("go");
    expect(normalized.files["main.go"].content).toContain("package main");
    expect(normalized.files["main.go"].content).toContain("const currentLesson");
    expect(normalized.files["m03_collections_pointers.go"].content).toContain("slices.Clone");
    expect(normalized.files["COURSE.md"].language).toBe("markdown");
  });

  it("keeps main.go a thin runner with no lesson titles or ordering", () => {
    const starter = createStarterGoWorkspace();
    const runner = starter.files["main.go"].content as string;

    expect(runner).toContain("func register(");
    expect(runner).toContain("func main()");
    // Keys, titles, and ordering live in the module files' init funcs.
    expect(runner).not.toMatch(/register\("/);
    expect(runner).not.toContain("Read a Go File Top-Down");
    expect(runner).not.toContain("lessonOrder");
  });

  it("registers one runnable demo per course lesson (25 lessons)", () => {
    const starter = createStarterGoWorkspace();
    const moduleFiles = Object.keys(starter.files).filter((path) => /^m\d{2}_.*\.go$/.test(path));
    expect(moduleFiles).toHaveLength(10);

    const registeredKeys: string[] = [];
    for (const path of moduleFiles) {
      const content = starter.files[path].content as string;
      const keys = [...content.matchAll(/register\("(\d+\.\d+)", "/g)].map((match) => match[1]);

      // Every module file registers its own lessons, under its own number.
      expect(keys.length).toBeGreaterThan(0);
      const moduleNumber = String(Number(path.slice(1, 3)));
      for (const key of keys) {
        expect(key.split(".")[0]).toBe(moduleNumber);
      }
      registeredKeys.push(...keys);
    }

    expect(registeredKeys).toHaveLength(25);
    expect(new Set(registeredKeys).size).toBe(25);
  });
});
