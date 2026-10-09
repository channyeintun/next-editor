// The lesson-type catalogue: each type's display name and picker order, the
// backend that executes its code, and the runtime surfaces it offers.
import type { WorkspaceLessonType } from "../core/src/workspace";

/**
 * Display names, and the order the lesson-type picker offers them in.
 *
 * A `Record` keyed by the union rather than a hand-kept array: adding a lesson
 * type without naming it fails the typecheck. Three separate lists used to
 * enumerate these by hand, and all three drifted — `kite` was runnable for a
 * while but absent from the picker, so nothing offered it.
 */
export const WORKSPACE_LESSON_TYPE_LABELS: Record<WorkspaceLessonType, string> = {
  "html-css": "HTML / CSS",
  react: "React",
  vue: "Vue",
  solid: "Solid",
  svelte: "Svelte",
  "htmx-express": "HTMX + Express",
  "alpine-express": "Alpine AJAX + Express",
  "express-ts": "Express + TypeScript",
  javascript: "JavaScript / Node.js",
  typescript: "TypeScript",
  go: "Go",
  kotlin: "Kotlin",
  python: "Python",
  rust: "Rust",
  zig: "Zig",
  haskell: "Haskell",
  kite: "Kite",
  "kite-web": "Kite + Vite (web)",
  asm: "x86-64 Assembly",
};

/** Every lesson type, in picker order. */
export const WORKSPACE_LESSON_TYPES = Object.keys(
  WORKSPACE_LESSON_TYPE_LABELS,
) as WorkspaceLessonType[];

export function isWorkspaceLessonType(value: unknown): value is WorkspaceLessonType {
  // hasOwn, not `in`: the labels table is a plain object, so `in` would narrow
  // "constructor" and every other Object.prototype key to a lesson type.
  return typeof value === "string" && Object.hasOwn(WORKSPACE_LESSON_TYPE_LABELS, value);
}

/**
 * Which backend executes code for a lesson. `go`, `kotlin`, `rust`, `zig`,
 * and `haskell` lessons compile through their respective playground proxies
 * on the main Worker. `kite` compiles in the browser: `kitec` is a Rust
 * program, and the Wasm build of it runs here, so it needs no proxy and no
 * service. `asm` needs no service either, for a different reason: its
 * assembler and its x86-64 machine are first-party TypeScript in
 * `src/core/x86`, so a run never leaves the page. Everything else keeps the
 * WebContainer runtime. Derived from `lessonType` — never persisted as a
 * second field (see docs/go-lessons-selective-runtime-plan.md §6).
 */
export type WorkspaceExecutionKind =
  | "webcontainer"
  | "go-playground"
  | "kotlin-playground"
  | "rust-playground"
  | "zig-playground"
  | "haskell-playground"
  | "kite-playground"
  | "asm-playground";

/**
 * Every browser-runtime lesson type is served by its own dev server inside the
 * WebContainer: the Vite-based SPAs (react, vue, solid, svelte) and html-css
 * run a Vite dev server, while htmx-express, alpine-express, and express-ts run
 * an Express server. The language-level javascript and typescript lessons run
 * their entry script with Node (exit-and-rerun, like python), but keep the
 * full Node runtime — they may install packages or start servers. Python also
 * runs in the WebContainer, but through its experimental WASI interpreter —
 * the runner executes the script and exits instead of keeping a server alive.
 * Go, Kotlin, Rust, Zig, and Haskell are deliberately excluded because they
 * use the selective Playground execution paths.
 *
 * A `Record` keyed by the union, like the labels above: a new lesson type that
 * has not chosen its backend fails the typecheck instead of falling through to
 * "webcontainer" while lessonRunsInWebContainer says otherwise.
 */
const EXECUTION_KIND_BY_LESSON_TYPE: Record<WorkspaceLessonType, WorkspaceExecutionKind> = {
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
  // Kite's compiler is WebAssembly, so `vite-plugin-kite` builds inside the
  // container with nothing native installed — which a `kite` lesson does not
  // need, because it compiles in the page and has no server or preview.
  "kite-web": "webcontainer",
  asm: "asm-playground",
};

export function executionKindForLessonType(
  lessonType: WorkspaceLessonType,
): WorkspaceExecutionKind {
  return EXECUTION_KIND_BY_LESSON_TYPE[lessonType];
}

export function lessonRunsInWebContainer(lessonType: WorkspaceLessonType): boolean {
  return executionKindForLessonType(lessonType) === "webcontainer";
}

// Capability predicates stay separate from the execution kind so a Go lesson
// can expose Run and console output without exposing Terminal or Preview.
export function lessonSupportsTerminal(lessonType: WorkspaceLessonType): boolean {
  return lessonRunsInWebContainer(lessonType);
}

export function lessonSupportsPreview(lessonType: WorkspaceLessonType): boolean {
  // WebContainer's WASI Python cannot bind server sockets, so a python lesson
  // never produces a previewable URL — its only output surface is the console.
  return lessonRunsInWebContainer(lessonType) && lessonType !== "python";
}
