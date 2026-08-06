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
import { createStarterPythonWorkspace } from "../starters/python";
import { createStarterKiteWorkspace } from "../starters/kite";
import { createStarterRustWorkspace } from "../starters/rust";

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
  javascript: "webcontainer",
  typescript: "webcontainer",
  go: "go-playground",
  kotlin: "kotlin-playground",
  python: "webcontainer",
  rust: "rust-playground",
  kite: "kite-playground",
  // The web starter is a Vite project, so it builds and serves in the
  // container like any other — the compiler it installs is WebAssembly.
  "kite-web": "webcontainer",
};

// Kite joins these because it also runs code without the WebContainer — but it
// is the only one that needs no service to do it, compiling in the page.
const PLAYGROUND_LESSON_TYPES: ReadonlySet<WorkspaceLessonType> = new Set([
  "go",
  "kotlin",
  "rust",
  "kite",
]);

// WebContainer lessons whose runner is a script that exits instead of a dev
// server — they keep Run and Terminal but have no preview surface.
const CONSOLE_ONLY_WEB_CONTAINER_LESSON_TYPES: ReadonlySet<WorkspaceLessonType> = new Set([
  "python",
]);

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
      expect(lessonSupportsPreview(lessonType)).toBe(
        !CONSOLE_ONLY_WEB_CONTAINER_LESSON_TYPES.has(lessonType),
      );
    }
  });
});

describe("rust workspace model", () => {
  it("maps .rs files to Monaco's rust language id", () => {
    expect(inferLanguageFromPath("main.rs")).toBe("rust");
    expect(inferLanguageFromPath("src/lib.rs")).toBe("rust");
  });

  it("round-trips a rust starter through project normalization without falling back", () => {
    const starter = createStarterRustWorkspace();
    const normalized = normalizeProject(starter);

    expect(normalized.lessonType).toBe("rust");
    expect(normalized.entryFilePath).toBe("main.rs");
    expect(normalized.files["main.rs"].language).toBe("rust");
    expect(normalized.files["main.rs"].content).toContain("fn main()");
    expect(normalized.files["README.md"].language).toBe("markdown");
  });
});

describe("kite workspace model", () => {
  it("colours .kite with Monaco's rust grammar, which is the closest fit", () => {
    expect(inferLanguageFromPath("main.kite")).toBe("rust");
    expect(inferLanguageFromPath("src/checkout.kite")).toBe("rust");
  });

  it("round-trips a kite starter through project normalization without falling back", () => {
    const starter = createStarterKiteWorkspace();
    const normalized = normalizeProject(starter);

    expect(normalized.lessonType).toBe("kite");
    expect(normalized.entryFilePath).toBe("main.kite");
    expect(normalized.files["main.kite"].content).toContain("fn main()");
    expect(normalized.files["README.md"].language).toBe("markdown");
  });

  it("executes in the page rather than through a playground proxy", () => {
    expect(executionKindForLessonType("kite")).toBe("kite-playground");
    expect(lessonRunsInWebContainer("kite")).toBe(false);
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

describe("python workspace model", () => {
  it("maps .py files to Monaco's python language id", () => {
    expect(inferLanguageFromPath("main.py")).toBe("python");
    expect(inferLanguageFromPath("src/helpers.py")).toBe("python");
  });

  it("round-trips a python starter through project normalization without falling back", () => {
    const starter = createStarterPythonWorkspace();
    const normalized = normalizeProject(starter);

    expect(normalized.lessonType).toBe("python");
    expect(normalized.entryFilePath).toBe("main.py");
    expect(normalized.files["main.py"].language).toBe("python");
    expect(normalized.files["main.py"].content).toContain("describe_squares");
    expect(normalized.files["helpers.py"].content).toContain("def greet");
  });

  it("wires the runner's dev script to the WebContainer python interpreter", () => {
    const starter = createStarterPythonWorkspace();
    const packageJson = JSON.parse(starter.files["package.json"].content as string) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };

    expect(packageJson.scripts?.dev).toBe("python3 main.py");
    // Stdlib-only: `pnpm install` must stay a no-op with nothing to resolve.
    expect(packageJson.dependencies).toBeUndefined();
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
