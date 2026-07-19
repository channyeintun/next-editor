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
import { createStarterKotlinWorkspace } from "../starters/kotlin";

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
  kotlin: "kotlin-playground",
};

const PLAYGROUND_LESSON_TYPES: ReadonlySet<WorkspaceLessonType> = new Set(["go", "kotlin"]);

const ALL_LESSON_TYPES = Object.keys(EXPECTED_EXECUTION_KIND) as WorkspaceLessonType[];

describe("execution selection", () => {
  it.each(ALL_LESSON_TYPES)("selects the right backend for %s", (lessonType) => {
    expect(executionKindForLessonType(lessonType)).toBe(EXPECTED_EXECUTION_KIND[lessonType]);
  });

  it("keeps playground lessons out of the WebContainer set without touching existing types", () => {
    for (const lessonType of ALL_LESSON_TYPES) {
      expect(lessonRunsInWebContainer(lessonType)).toBe(!PLAYGROUND_LESSON_TYPES.has(lessonType));
    }
  });
});

describe("lesson capabilities", () => {
  it.each([...PLAYGROUND_LESSON_TYPES])(
    "gives %s lessons Run without Terminal or Preview",
    (lessonType) => {
      expect(lessonSupportsCodeRun(lessonType)).toBe(true);
      expect(lessonSupportsTerminal(lessonType)).toBe(false);
      expect(lessonSupportsPreview(lessonType)).toBe(false);
    },
  );

  it("keeps every WebContainer lesson's capabilities unchanged", () => {
    for (const lessonType of ALL_LESSON_TYPES.filter(
      (type) => !PLAYGROUND_LESSON_TYPES.has(type),
    )) {
      expect(lessonSupportsCodeRun(lessonType)).toBe(true);
      expect(lessonSupportsTerminal(lessonType)).toBe(true);
      expect(lessonSupportsPreview(lessonType)).toBe(true);
    }
  });
});

describe("kotlin workspace model", () => {
  it("maps .kt files to Monaco's kotlin language id", () => {
    expect(inferLanguageFromPath("Main.kt")).toBe("kotlin");
    expect(inferLanguageFromPath("script.kts")).toBe("kotlin");
  });

  it("round-trips a kotlin starter through project normalization without falling back", () => {
    const starter = createStarterKotlinWorkspace();
    const normalized = normalizeProject(starter);

    expect(normalized.lessonType).toBe("kotlin");
    expect(normalized.entryFilePath).toBe("Main.kt");
    expect(normalized.files["Main.kt"].language).toBe("kotlin");
    expect(normalized.files["Main.kt"].content).toContain("fun main()");
    expect(normalized.files["README.md"].language).toBe("markdown");
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
    expect(normalized.files["main.go"].content).toContain("square(i)");
    expect(normalized.files["square.go"].content).toContain("func square");
  });
});
