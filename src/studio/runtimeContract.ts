import type {
  StudioLessonType,
  StudioPlanAction,
  StudioPlanActionType,
  StudioRuntime,
  StudioRuntimeKind,
  StudioWorkspacePin,
} from "./plan";

/**
 * The runtime contract both the script schema and the plan schema check: which
 * runtime kind a lesson type uses, how a WebContainer runtime must be set up,
 * and which actions each runtime kind can perform. It lives here once so the
 * two schemas cannot drift apart. When each schema had its own copy, they did:
 * only the script's runtime-"none" list had runtime.collapseDock.
 */

/**
 * The one runtime kind each lesson type may declare. Go, Kotlin, Rust, Zig,
 * and Haskell execute through their selective proxies, Kite on its in-page
 * WebAssembly compiler, asm on its in-page TypeScript assembler and x86-64
 * machine; JavaScript, TypeScript, and
 * Python all run in the versioned WebContainer adapter. JS/TS drive a dev server
 * + preview; Python runs one-shot on the WebContainer's built-in WASI `python3`
 * (no server, no preview) and gates on console `expect.output` — the per-lesson
 * action rules are enforced in `runtimeContractIssues` below.
 */
export const RUNTIME_KIND_FOR_LESSON: Record<StudioLessonType, StudioRuntimeKind> = {
  javascript: "webcontainer",
  typescript: "webcontainer",
  python: "webcontainer",
  go: "go-playground",
  kotlin: "kotlin-playground",
  rust: "rust-playground",
  zig: "zig-playground",
  haskell: "haskell-playground",
  kite: "kite-playground",
  asm: "asm-playground",
};

type PreviewClickAction = Extract<StudioPlanAction, { type: "preview.click" }>;
type ExpectPreviewAction = Extract<StudioPlanAction, { type: "expect.preview" }>;

/**
 * The fields of an action these checks read. A script action and a plan action
 * both have them, so each schema passes its own actions in. `type` is the
 * action-type union, not a string, so a misspelled type in a comparison below
 * is a compile error.
 */
export type ContractAction =
  | Pick<PreviewClickAction, "id" | "type" | "retry">
  | Pick<
      ExpectPreviewAction,
      "id" | "type" | "target" | "route" | "textContains" | "value" | "attribute"
    >
  | { id: string; type: Exclude<StudioPlanActionType, "preview.click" | "expect.preview"> };

/** Every way the runtime and the actions break the runtime contract, in a fixed order. */
export function runtimeContractIssues(
  workspace: StudioWorkspacePin,
  runtime: StudioRuntime,
  actions: ReadonlyArray<ContractAction>,
): string[] {
  const issues: string[] = [];
  const expectedKind = RUNTIME_KIND_FOR_LESSON[workspace.lessonType];
  if (runtime.kind !== expectedKind) {
    issues.push(
      `Lesson type "${workspace.lessonType}" requires runtime kind "${expectedKind}", got "${runtime.kind}"`,
    );
  }
  if (runtime.kind === "none") {
    for (const action of actions) {
      if (
        action.type === "runtime.run" ||
        action.type === "runtime.start" ||
        action.type === "runtime.waitForReady" ||
        // A lesson with no runtime never renders a runner dock to collapse.
        action.type === "runtime.collapseDock" ||
        action.type.startsWith("preview.") ||
        action.type === "expect.preview" ||
        action.type === "expect.output"
      ) {
        issues.push(
          `Action "${action.id}" (${action.type}) needs a runnable runtime, but lesson type "${workspace.lessonType}" has none in the studio yet`,
        );
      }
    }
  }
  if (runtime.kind === "webcontainer") {
    // Python runs one-shot on the WebContainer's WASI `python3`: no package
    // install (so no lockfile), no dev server, no preview. JS/TS drive a dev
    // server + preview and must pin a lockfile for a reproducible install.
    const isPython = workspace.lessonType === "python";
    if (runtime.lockfilePath === undefined) {
      if (!isPython) {
        issues.push(
          `A ${workspace.lessonType} WebContainer lesson must pin a lockfilePath for a reproducible install`,
        );
      }
    } else if (!(runtime.lockfilePath in workspace.files)) {
      issues.push(`WebContainer lockfile "${runtime.lockfilePath}" is not in the pinned workspace`);
    }
    if (isPython) {
      if (runtime.lockfilePath !== undefined) {
        issues.push("A Python WebContainer lesson must omit lockfilePath (nothing is installed)");
      }
      if (runtime.expectedPort !== undefined) {
        issues.push("A Python WebContainer lesson must omit expectedPort (it has no server)");
      }
      if (runtime.initCommand.trim() !== "") {
        issues.push("A Python WebContainer lesson must use an empty initCommand");
      }
      if (!/^python3(?:\s|$)/.test(runtime.runCommand.trim())) {
        issues.push('A Python WebContainer lesson runCommand must invoke "python3"');
      }
    }
    for (const action of actions) {
      if (action.type === "runtime.run") {
        issues.push(
          `Action "${action.id}" (runtime.run) is a Playground command; a WebContainer lesson runs via runtime.start`,
        );
      }
      if (isPython) {
        // WASI Python cannot bind a socket, so it has no server to wait for and
        // no preview to interact with — it asserts through console expect.output.
        if (
          action.type === "runtime.waitForReady" ||
          action.type.startsWith("preview.") ||
          action.type === "expect.preview"
        ) {
          issues.push(
            `Action "${action.id}" (${action.type}) needs a preview server; Python runs one-shot to the console — assert with expect.output`,
          );
        }
      } else if (action.type === "expect.output") {
        issues.push(
          `Action "${action.id}" (expect.output) is for console runtimes; a ${workspace.lessonType} preview lesson asserts with expect.preview`,
        );
      }
    }
  } else if (runtime.kind !== "none") {
    for (const action of actions) {
      if (
        action.type === "runtime.start" ||
        action.type === "runtime.waitForReady" ||
        action.type.startsWith("preview.") ||
        action.type === "expect.preview"
      ) {
        issues.push(`Action "${action.id}" (${action.type}) requires runtime kind "webcontainer"`);
      }
    }
  }
  return issues;
}

/**
 * The checks on single actions that do not depend on the runtime: a click must
 * not retry, a preview expectation needs something stable to check, and every
 * action id is unique.
 */
export function actionContractIssues(actions: ReadonlyArray<ContractAction>): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const action of actions) {
    if (action.type === "preview.click" && action.retry.maxAttempts !== 1) {
      issues.push(`Action "${action.id}" is non-idempotent and must use retry.maxAttempts: 1`);
    }
    if (
      action.type === "expect.preview" &&
      action.target === undefined &&
      action.route === undefined
    ) {
      issues.push(`Action "${action.id}" must declare a preview target or route expectation`);
    }
    if (
      action.type === "expect.preview" &&
      action.target === undefined &&
      (action.textContains !== undefined ||
        action.value !== undefined ||
        action.attribute !== undefined)
    ) {
      issues.push(
        `Action "${action.id}" needs a stable target for text, value, or attribute checks`,
      );
    }
    if (ids.has(action.id)) {
      issues.push(`Duplicate action id "${action.id}"`);
    }
    ids.add(action.id);
  }
  return issues;
}
