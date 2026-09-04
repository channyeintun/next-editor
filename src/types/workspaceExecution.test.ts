import { describe, expect, it } from "vitest";
import {
  executionKindForLessonType,
  isWorkspaceTextFile,
  inferLanguageFromPath,
  isWorkspaceLessonType,
  lessonRunsInWebContainer,
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
import { createStarterZigWorkspace } from "../starters/zig";
import { createStarterHaskellWorkspace } from "../starters/haskell";
import { createStarterAsmWorkspace } from "../starters/asm";

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
  zig: "zig-playground",
  haskell: "haskell-playground",
  kite: "kite-playground",
  // The web starter is a Vite project, so it builds and serves in the
  // container like any other — the compiler it installs is WebAssembly.
  "kite-web": "webcontainer",
  asm: "asm-playground",
};

// Kite and asm join these because they also run code without the WebContainer,
// and they are the two that need no service to do it: Kite compiles in the page
// on a Wasm build of `kitec`, and asm assembles and executes in the page on the
// first-party machine in src/core/x86.
const PLAYGROUND_LESSON_TYPES: ReadonlySet<WorkspaceLessonType> = new Set([
  "go",
  "kotlin",
  "rust",
  "zig",
  "haskell",
  "kite",
  "asm",
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

describe("isWorkspaceLessonType", () => {
  it("accepts every known lesson type", () => {
    for (const lessonType of ALL_LESSON_TYPES) {
      expect(isWorkspaceLessonType(lessonType)).toBe(true);
    }
  });

  it("rejects inherited object keys, not just unknown strings", () => {
    // The labels table is a plain object literal, so a prototype-key probe from
    // a collaborator's client must not narrow to WorkspaceLessonType and end up
    // indexing a Record<WorkspaceLessonType, …> table with it.
    for (const value of [
      "",
      "rust-web",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ]) {
      expect(isWorkspaceLessonType(value)).toBe(false);
    }
    expect(isWorkspaceLessonType(7)).toBe(false);
    expect(isWorkspaceLessonType(null)).toBe(false);
  });
});

describe("lesson capabilities", () => {
  it.each([...PLAYGROUND_LESSON_TYPES])(
    "keeps Terminal and Preview off for %s lessons",
    (lessonType) => {
      expect(lessonSupportsTerminal(lessonType)).toBe(false);
      expect(lessonSupportsPreview(lessonType)).toBe(false);
    },
  );

  it("keeps every WebContainer lesson's capabilities unchanged", () => {
    for (const lessonType of ALL_LESSON_TYPES.filter(
      (type) => !PLAYGROUND_LESSON_TYPES.has(type),
    )) {
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

describe("zig workspace model", () => {
  it("maps .zig and .zon to the first-party zig language id", () => {
    // Monaco ships no Zig grammar; monaco/zigLanguage.ts registers this id.
    expect(inferLanguageFromPath("main.zig")).toBe("zig");
    expect(inferLanguageFromPath("build.zig.zon")).toBe("zig");
  });

  it("round-trips a zig starter through project normalization without falling back", () => {
    const starter = createStarterZigWorkspace();
    const normalized = normalizeProject(starter);

    expect(normalized.lessonType).toBe("zig");
    expect(normalized.entryFilePath).toBe("main.zig");
    expect(normalized.files["main.zig"].language).toBe("zig");
    expect(normalized.files["main.zig"].content).toContain("pub fn main()");
    expect(normalized.files["README.md"].language).toBe("markdown");
  });

  it("keeps the starter on the Zig 0.16 std APIs it claims to target", () => {
    // 0.16 moved exactly these out from under older tutorials: ArrayList became
    // unmanaged (allocator per call) and the GPA was renamed. A starter that
    // regressed to the old spellings would not compile on the playground.
    const source = createStarterZigWorkspace().files["main.zig"].content;

    expect(source).toContain("std.heap.DebugAllocator(.{})");
    expect(source).toContain("squares.deinit(allocator)");
    expect(source).toContain("squares.append(allocator,");
    expect(source).not.toContain("GeneralPurposeAllocator");
    expect(source).not.toContain("ArrayList(u32).init(");
  });
});

describe("haskell workspace model", () => {
  it("maps .hs to the first-party haskell language id", () => {
    // Monaco ships no Haskell grammar; monaco/haskellLanguage.ts registers this
    // id. `.lhs` is literate Haskell — a different format the playground does
    // not compile — so it deliberately stays plaintext.
    expect(inferLanguageFromPath("Main.hs")).toBe("haskell");
    expect(inferLanguageFromPath("src/Parser.hs")).toBe("haskell");
    expect(inferLanguageFromPath("Main.lhs")).toBe("plaintext");
  });

  it("round-trips a haskell starter through project normalization without falling back", () => {
    const starter = createStarterHaskellWorkspace();
    const normalized = normalizeProject(starter);

    expect(normalized.lessonType).toBe("haskell");
    // Capital M: GHC's diagnostics name Main.hs, so the editor's file must too.
    expect(normalized.entryFilePath).toBe("Main.hs");
    expect(normalized.files["Main.hs"].language).toBe("haskell");
    expect(normalized.files["Main.hs"].content).toContain("main :: IO ()");
    expect(normalized.files["README.md"].language).toBe("markdown");
  });

  it("keeps the starter on the idioms it exists to teach", () => {
    // The starter's whole job is to show a type signature, a data type, and
    // pattern matching before a learner writes a line. It also has to stay a
    // single module: the playground compiles one Main.hs, so an import of a
    // sibling file — or a Hackage package — would not resolve.
    const source = createStarterHaskellWorkspace().files["Main.hs"].content;

    expect(source).toContain("module Main where");
    expect(source).toContain("describe :: Event -> String");
    expect(source).toContain("data Event");
    expect(source).toContain("deriving (Show)");
    expect(source).toContain("failedAttempts (_ : rest)");
    expect(source).not.toContain("\nimport ");
  });
});

describe("assembly workspace model", () => {
  it("maps every assembly extension to the first-party asm language id", () => {
    // Monaco ships a generic `asm` grammar that colours neither NASM's
    // directives nor the registers; monaco/asmLanguage.ts registers a real one.
    expect(inferLanguageFromPath("main.asm")).toBe("asm");
    expect(inferLanguageFromPath("boot.s")).toBe("asm");
    expect(inferLanguageFromPath("src/vector.nasm")).toBe("asm");
  });

  it("round-trips an assembly starter through project normalization without falling back", () => {
    const starter = createStarterAsmWorkspace();
    const normalized = normalizeProject(starter);

    expect(normalized.lessonType).toBe("asm");
    expect(normalized.entryFilePath).toBe("main.asm");
    expect(normalized.files["main.asm"].language).toBe("asm");
    expect(normalized.files["main.asm"].content).toContain("global _start");
  });

  it("keeps the starter on the Linux system-call convention it teaches", () => {
    // These four lines are the lesson: the call number in rax, the file
    // descriptor in rdi, the buffer in rsi, the length in rdx. A starter that
    // drifted off them would be teaching a convention that is not Linux's.
    const file = createStarterAsmWorkspace().files["main.asm"];
    if (!isWorkspaceTextFile(file)) throw new Error("the starter must be a text file");

    expect(file.content).toContain("mov     rax, 1");
    expect(file.content).toContain("mov     rax, 60");
    expect(file.content).toContain("syscall");
    expect(file.content).toContain("$ - msg");
  });
});

describe("kite workspace model", () => {
  it("maps .kite to the first-party kite language id", () => {
    // Was Monaco's `rust` grammar, which leaves `var`, `check`, `defer` and
    // `nil` uncoloured and swallows `\(…)` holes — monaco/kiteLanguage.ts now
    // registers a real one.
    expect(inferLanguageFromPath("main.kite")).toBe("kite");
    expect(inferLanguageFromPath("src/checkout.kite")).toBe("kite");
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
