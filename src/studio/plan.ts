import { z } from "zod";
import type { CaptionTrack } from "../core/src/types";
import { whiteboardDrawDurationMs } from "./whiteboardAssets";

/**
 * Compiled lesson plan — the deterministic contract between the Director (asset
 * build) and the in-app Performer (docs/agent-lesson-production.md §4/§5).
 *
 * M0 scope: plans are authored as checked-in TypeScript modules and validated
 * with this schema at load time. The YAML `LessonScript` + marker compiler is
 * M1; nothing here may depend on narration markers or wall-clock times. Every
 * `at` is an absolute millisecond offset on the recording clock, and every
 * generated duration (typing chunk delays, cursor tween lengths) is already
 * materialized so performing the same plan twice never re-rolls them.
 */

export const STUDIO_PLAN_SCHEMA_VERSION = 1;

const nonNegativeMs = z.number().finite().min(0);
const positiveMs = z.number().finite().positive();

/**
 * Ceiling on a drawn `whiteboard.apply`. A diagram that takes longer than this
 * to appear has stopped being an illustration and started being the lesson;
 * it also has to stay under the action's own `timeoutMs`.
 */
export const WHITEBOARD_DRAW_MAX_MS = 6_000;

/** Materialized retry policy. One attempt means explicitly non-retryable. */
export const studioRetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(3),
  delayMs: nonNegativeMs,
});
export type StudioRetryPolicy = z.infer<typeof studioRetryPolicySchema>;

const planActionBase = z.object({
  /** Unique, stable action id — receipts and reports key off it. */
  id: z.string().min(1),
  /** Absolute planned start time on the recording clock (ms). */
  at: nonNegativeMs,
  /** Hard deadline for the command to acknowledge; the render fails closed past it. */
  timeoutMs: positiveMs.default(10_000),
});

/** Durable UI target reference. Missing targets are render failures, never guesses. */
export const studioTargetRefSchema = z.union([
  z.object({ kind: z.literal("file"), path: z.string().min(1) }),
  z.object({ kind: z.literal("editor") }),
  z.object({ kind: z.literal("run-button") }),
  z.object({ kind: z.literal("target-id"), id: z.string().min(1) }),
]);
export type StudioTargetRef = z.infer<typeof studioTargetRefSchema>;

/** Stable author-owned target inside a cross-origin runtime preview. */
export const studioPreviewTargetSchema = z.object({
  by: z.literal("testId"),
  value: z.string().min(1),
});
export type StudioPreviewTarget = z.infer<typeof studioPreviewTargetSchema>;

/**
 * Text anchor inside one workspace file. Resolution is exact-substring +
 * occurrence; a missing occurrence fails the action (the Performer never
 * guesses a location — docs/agent-lesson-production.md §5 script rules).
 */
export const textAnchorSchema = z.object({
  /** Insert after the end of this exact substring ("" = start of file). */
  after: z.string(),
  /** 1-based occurrence of `after` within the file. */
  occurrence: z.number().int().min(1).default(1),
});
export type TextAnchor = z.infer<typeof textAnchorSchema>;

/**
 * Selection span inside one workspace file. Resolution is exact-substring +
 * occurrence (same rule as `TextAnchor`): the `occurrence`-th match of `text`
 * becomes the highlighted range. A missing occurrence fails the action — the
 * Performer never guesses a range.
 */
export const selectionAnchorSchema = z.object({
  /** Exact substring to select (byte-for-byte, including `\n` and `\t`). */
  text: z.string().min(1),
  /** 1-based occurrence of `text` within the file. */
  occurrence: z.number().int().min(1).default(1),
});
export type SelectionAnchor = z.infer<typeof selectionAnchorSchema>;

/**
 * One pre-compiled typing burst: wait `delayMs` since the previous chunk, then
 * insert `text`. Chunks normally land in text order; `offsetInText` (the
 * chunk's position within the action's final inserted text) lets a chunk land
 * out of order — used to press Enter first so existing code moves to the next
 * line before any characters are typed in front of it.
 */
export const typingChunkSchema = z.object({
  delayMs: nonNegativeMs,
  text: z.string().min(1),
  offsetInText: z.number().int().nonnegative().optional(),
});
export type TypingChunk = z.infer<typeof typingChunkSchema>;

const openFileActionSchema = planActionBase.extend({
  type: z.literal("workspace.openFile"),
  path: z.string().min(1),
});

const cursorMoveActionSchema = planActionBase.extend({
  type: z.literal("cursor.moveTo"),
  target: studioTargetRefSchema,
  /** Materialized tween duration (seed-derived at compile time). */
  durationMs: positiveMs,
});

const editorTypeActionSchema = planActionBase.extend({
  type: z.literal("editor.type"),
  path: z.string().min(1),
  anchor: textAnchorSchema,
  /** Materialized chunk schedule; total typing time is the sum of delays. */
  chunks: z.array(typingChunkSchema).min(1),
});

const editorSelectActionSchema = planActionBase.extend({
  type: z.literal("editor.select"),
  path: z.string().min(1),
  selection: selectionAnchorSchema,
  /** Materialized drag-glide duration across the range (seed-derived at compile time). */
  durationMs: positiveMs,
});

const runtimeRunActionSchema = planActionBase.extend({
  type: z.literal("runtime.run"),
});

const runtimeStartActionSchema = planActionBase.extend({
  type: z.literal("runtime.start"),
  retry: studioRetryPolicySchema,
});

const runtimeWaitForReadyActionSchema = planActionBase.extend({
  type: z.literal("runtime.waitForReady"),
  retry: studioRetryPolicySchema,
});

const runtimeCollapseDockActionSchema = planActionBase.extend({
  type: z.literal("runtime.collapseDock"),
});

const previewOpenActionSchema = planActionBase.extend({
  type: z.literal("preview.open"),
  mode: z.enum(["docked", "floating"]).default("docked"),
  retry: studioRetryPolicySchema,
});

const previewClickActionSchema = planActionBase.extend({
  type: z.literal("preview.click"),
  target: studioPreviewTargetSchema,
  retry: studioRetryPolicySchema,
});

const previewInputActionSchema = planActionBase.extend({
  type: z.literal("preview.input"),
  target: studioPreviewTargetSchema,
  value: z.string(),
  retry: studioRetryPolicySchema,
});

const previewScrollActionSchema = planActionBase.extend({
  type: z.literal("preview.scroll"),
  target: studioPreviewTargetSchema.optional(),
  top: z.number().finite(),
  left: z.number().finite().default(0),
  retry: studioRetryPolicySchema,
});

const previewRouteActionSchema = planActionBase.extend({
  type: z.literal("preview.route"),
  route: z.string().startsWith("/").min(1),
  retry: studioRetryPolicySchema,
});

const slideShowActionSchema = planActionBase.extend({
  type: z.literal("slide.show"),
  slideId: z.string().min(1),
  maximized: z.boolean().default(true),
});

const slideCloseActionSchema = planActionBase.extend({
  type: z.literal("slide.close"),
});

const whiteboardApplyActionSchema = planActionBase
  .extend({
    type: z.literal("whiteboard.apply"),
    open: z.boolean().optional(),
    maximized: z.boolean().optional(),
    /** Ids from `plan.whiteboardAssets` to upsert onto the board. */
    upsertIds: z.array(z.string().min(1)).default([]),
    /**
     * Wipe the board first — everything already on it is removed, then this
     * action's upserts are drawn onto the empty canvas. Without this a second
     * diagram authored over the same coordinates draws on top of the first,
     * since an apply otherwise only ever adds.
     */
    clear: z.boolean().default(false),
    /**
     * Draw the upserts in over this budget instead of applying them in one
     * frame: shapes grow, text types, strokes trace, and multiple assets are
     * staggered in order. `0` (the default) keeps the single-frame apply.
     */
    drawMs: z.number().finite().nonnegative().max(WHITEBOARD_DRAW_MAX_MS).default(0),
  })
  .refine(
    (action) =>
      action.open !== undefined ||
      action.maximized !== undefined ||
      action.upsertIds.length > 0 ||
      action.clear,
    {
      message:
        "whiteboard.apply must open/close, change maximize, clear the board, or upsert at least one asset",
    },
  )
  .refine((action) => action.drawMs < action.timeoutMs, {
    message: "whiteboard.apply drawMs must be shorter than the action's timeoutMs",
  });

const expectOutputActionSchema = planActionBase.extend({
  type: z.literal("expect.output"),
  contains: z.string().min(1),
});

const expectFileActionSchema = planActionBase.extend({
  type: z.literal("expect.file"),
  path: z.string().min(1),
  contains: z.string().min(1),
});

const expectPreviewActionSchema = planActionBase.extend({
  type: z.literal("expect.preview"),
  target: studioPreviewTargetSchema.optional(),
  textContains: z.string().min(1).optional(),
  value: z.string().optional(),
  route: z.string().startsWith("/").min(1).optional(),
  attribute: z.object({ name: z.string().min(1), value: z.string() }).optional(),
  retry: studioRetryPolicySchema,
});

export const studioPlanActionSchema = z.discriminatedUnion("type", [
  openFileActionSchema,
  cursorMoveActionSchema,
  editorTypeActionSchema,
  editorSelectActionSchema,
  runtimeRunActionSchema,
  runtimeStartActionSchema,
  runtimeWaitForReadyActionSchema,
  runtimeCollapseDockActionSchema,
  previewOpenActionSchema,
  previewClickActionSchema,
  previewInputActionSchema,
  previewScrollActionSchema,
  previewRouteActionSchema,
  slideShowActionSchema,
  slideCloseActionSchema,
  whiteboardApplyActionSchema,
  expectOutputActionSchema,
  expectFileActionSchema,
  expectPreviewActionSchema,
]);
export type StudioPlanAction = z.infer<typeof studioPlanActionSchema>;
export type StudioPlanActionType = StudioPlanAction["type"];

/**
 * Lesson types are the languages the platform teaches — not the starter
 * templates (react, vue, …), which are just seeded workspace conveniences.
 * javascript/typescript lessons pin arbitrary WebContainer (Node) workspaces;
 * python runs its WASI script model; go/kotlin/rust/zig/haskell use their
 * playgrounds; kite and asm need no service at all, compiling and running in
 * the page.
 * Each value is also a valid `WorkspaceLessonType` for the pinned project.
 */
export const studioLessonTypeSchema = z.enum([
  "javascript",
  "typescript",
  "python",
  "go",
  "kotlin",
  "rust",
  "zig",
  "haskell",
  "kite",
  "asm",
]);
export type StudioLessonType = z.infer<typeof studioLessonTypeSchema>;

/** Pinned workspace: full file contents, no external template resolution in M0. */
export const studioWorkspacePinSchema = z.object({
  lessonType: studioLessonTypeSchema,
  name: z.string().min(1),
  entryFilePath: z.string().min(1),
  files: z.record(z.string().min(1), z.string()),
  /**
   * Open with the file explorer shut. For a lesson whose workspace is one
   * file, the tree is a list of one taking width from the code beside it.
   * Pinned by the render before the clock starts and carried on the
   * recording's initial workspace snapshot, so playback opens the same way;
   * the viewer's own toggle still works, and nothing is written to their
   * stored preference.
   */
  sidebarStartsCollapsed: z.boolean().default(false),
});
export type StudioWorkspacePin = z.infer<typeof studioWorkspacePinSchema>;

/**
 * Pinned slide asset. markdown/html slides carry authored content inline;
 * google-svg slides carry the parsed, normalized SVG of one page of a
 * published Google Slides deck — resolved once at compile time so the plan
 * itself stays fully pinned (no fetches during the performance).
 */
export const studioSlideSchema = z.object({
  id: z.string().min(1),
  contentType: z.enum(["markdown", "html", "google-svg"]),
  content: z.string().min(1),
  name: z.string().optional(),
  /** Published deck the SVG came from (provenance, google-svg only). */
  sourceUrl: z.string().url().optional(),
});
export type StudioSlide = z.infer<typeof studioSlideSchema>;

/**
 * Hand-drawn annotation strokes. Each is generated inside the asset's box as
 * one continuous freedraw path, so it can be revealed point by point the way a
 * presenter draws it.
 */
export const studioWhiteboardStrokeSchema = z.enum([
  "underline",
  "strike",
  "circle",
  "check",
  "arrow-right",
  "arrow-down",
]);
export type StudioWhiteboardStroke = z.infer<typeof studioWhiteboardStrokeSchema>;

/**
 * Authored whiteboard asset: a small declarative spec the driver expands into
 * a full Excalidraw element (seeded, deterministic) at apply time.
 */
export const studioWhiteboardAssetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["rectangle", "ellipse", "text", "freedraw"]),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  text: z.string().optional(),
  /** `freedraw` only: which stroke fills the asset's box. */
  stroke: studioWhiteboardStrokeSchema.default("underline"),
  strokeColor: z.string().default("#e2e8f0"),
  backgroundColor: z.string().default("transparent"),
  fontSize: z.number().finite().positive().default(20),
});
export type StudioWhiteboardAsset = z.infer<typeof studioWhiteboardAssetSchema>;

const captionWordSchema = z.object({
  start: nonNegativeMs,
  end: nonNegativeMs,
  text: z.string().min(1),
});

const captionCueSchema = z.object({
  start: nonNegativeMs,
  end: nonNegativeMs,
  text: z.string().min(1),
  words: z.array(captionWordSchema).optional(),
});

export const studioCaptionTrackSchema = z.object({
  id: z.string().min(1),
  language: z.string().min(1),
  label: z.string().optional(),
  default: z.boolean().optional(),
  cues: z.array(captionCueSchema).min(1),
});

export const studioNarrationSchema = z.object({
  /** URL the studio route fetches the pre-generated narration from (same-origin asset). */
  audioPath: z.string().min(1),
  mimeType: z.string().min(1),
  /** Expected narration length; the recorder still measures the real duration. */
  expectedDurationMs: positiveMs,
  captions: studioCaptionTrackSchema,
});

/**
 * Deterministic stand-in for a live run: the exact normalized result the
 * Playground would return for the pinned sources. Fixture renders replay it
 * through the same console formatting path after `latencyMs`.
 */
export const goRunFixtureSchema = z.object({
  latencyMs: positiveMs,
  /**
   * Transient service failures to simulate before the result, one per attempt
   * — exercises the driver's declared-idempotent retry path deterministically.
   */
  transientErrorKinds: z.array(z.enum(["rate-limited", "timeout", "unavailable"])).default([]),
  result: z.object({
    status: z.enum(["success", "compile-error", "vet-error", "runtime-error"]),
    output: z.string(),
    compileErrors: z.string().optional(),
    vetErrors: z.string().optional(),
    exitCode: z.number().int().optional(),
  }),
});

/** Kotlin Playground stand-in result — mirrors the worker-normalized contract. */
export const kotlinRunFixtureSchema = z.object({
  latencyMs: positiveMs,
  transientErrorKinds: z.array(z.enum(["rate-limited", "timeout", "unavailable"])).default([]),
  result: z.object({
    status: z.enum(["success", "compile-error", "runtime-error"]),
    output: z.string(),
    compileErrors: z.string().optional(),
    warnings: z.string().optional(),
    exception: z.string().optional(),
  }),
});

/**
 * Zig's fixture result shape differs from the others by one field: zig-play.dev
 * runs the program with its streams merged and answers in text/plain, so there
 * is no stdout/stderr split to pin. Pinning two fields where the service
 * reports one would invite a fixture that no live run could ever reproduce.
 */
export const zigRunFixtureSchema = z.object({
  latencyMs: positiveMs,
  transientErrorKinds: z.array(z.enum(["rate-limited", "timeout", "unavailable"])).default([]),
  result: z.object({
    status: z.enum(["success", "compile-error", "runtime-error"]),
    output: z.string(),
    compileErrors: z.string().optional(),
    exitDetail: z.string().optional(),
  }),
});

/** Rust Playground stand-in result — mirrors the worker-normalized contract. */
export const rustRunFixtureSchema = z.object({
  latencyMs: positiveMs,
  transientErrorKinds: z.array(z.enum(["rate-limited", "timeout", "unavailable"])).default([]),
  result: z.object({
    status: z.enum(["success", "compile-error", "runtime-error"]),
    stdout: z.string(),
    stderr: z.string(),
    compileErrors: z.string().optional(),
    exitDetail: z.string().optional(),
  }),
});

/**
 * Haskell Playground stand-in result.
 *
 * Three text channels, not two: play.haskell.org answers with GHC's own
 * diagnostics (`ghcout`) alongside the program's `sout`/`serr`, so a run that
 * compiled with warnings and then printed something reports all three at once.
 * `warnings` is therefore its own optional field rather than something folded
 * into `stderr` — a successful run can carry warnings, and a fixture that
 * merged them would replay a console no live run could reproduce. It is the
 * mirror image of Zig, whose single `output` field exists because that service
 * really does merge its streams.
 *
 * `compileErrors` and `exitDetail` are mutually exclusive by construction:
 * GHC either rejected the module (nothing ran, so there is no exit status) or
 * built it and the program exited non-zero.
 */
export const haskellRunFixtureSchema = z.object({
  latencyMs: positiveMs,
  transientErrorKinds: z.array(z.enum(["rate-limited", "timeout", "unavailable"])).default([]),
  result: z.object({
    status: z.enum(["success", "compile-error", "runtime-error"]),
    stdout: z.string(),
    stderr: z.string(),
    compileErrors: z.string().optional(),
    warnings: z.string().optional(),
    exitDetail: z.string().optional(),
  }),
});

/**
 * Assembly stand-in result.
 *
 * Two transient error kinds are absent for the same reason Kite's are: the
 * assembler and the machine are TypeScript in this page, so a lesson cannot be
 * rate-limited or timed out by a service it never calls. What is left is the
 * one failure a first-party engine can still have — it did not load.
 *
 * `registers` and `flags` are optional and unique to this kind. Every other
 * language's fixture is what the program printed; an assembly lesson's console
 * also carries the register file, so a fixture that omits them replays a run
 * with no register lines, and one that includes them replays them exactly.
 */
export const asmRunFixtureSchema = z.object({
  latencyMs: positiveMs,
  transientErrorKinds: z.array(z.enum(["unavailable"])).default([]),
  result: z.object({
    status: z.enum(["success", "assemble-error", "runtime-error"]),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int().optional(),
    assembleErrors: z.string().optional(),
    exitDetail: z.string().optional(),
    instructions: z.number().int().nonnegative().optional(),
    registers: z
      .array(z.object({ name: z.string().min(1), value: z.string().regex(/^\d+$/) }))
      .optional(),
    flags: z
      .object({
        carry: z.boolean(),
        zero: z.boolean(),
        sign: z.boolean(),
        overflow: z.boolean(),
        parity: z.boolean(),
        adjust: z.boolean(),
      })
      .optional(),
  }),
});

/**
 * Kite stand-in result.
 *
 * The transient error kinds are two rather than three: Kite's compiler is
 * WebAssembly running in the page, so a lesson cannot be rate-limited by a
 * service it does not call.
 */
export const kiteRunFixtureSchema = z.object({
  latencyMs: positiveMs,
  transientErrorKinds: z.array(z.enum(["unavailable"])).default([]),
  result: z.object({
    status: z.enum(["success", "compile-error", "runtime-error"]),
    stdout: z.string(),
    stderr: z.string(),
    compileErrors: z.string().optional(),
    exitDetail: z.string().optional(),
  }),
});

/**
 * Execution-kind-specific runtime declaration. "live" calls the real
 * /api/<kind> proxy (requires a signed-in session); "fixture" replays the
 * pinned result. Unattended renders default to the plan's declared mode; the
 * manifest records which one ran. Kind "webcontainer" is the versioned JS/TS
 * lifecycle and preview contract. Kind "none" remains reserved for future
 * lesson types that narrate, edit, and use slides/whiteboard without a
 * Studio-owned execution surface.
 */
export const studioRuntimeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("webcontainer"),
    /** Version of the Studio/WebContainer command and readiness contract. */
    adapterVersion: z.literal(1),
    defaultMode: z.literal("live"),
    initCommand: z.string(),
    runCommand: z.string().min(1),
    expectedPort: z.number().int().min(1).max(65_535).optional(),
    /**
     * Exact contents are pinned in workspace.files and covered by the plan hash.
     * Required for JavaScript/TypeScript (reproducible npm/pnpm install); omitted
     * for Python, which runs one-shot on the WebContainer's built-in WASI
     * `python3` with no package install (validated per lessonType below).
     */
    lockfilePath: z.string().min(1).optional(),
    environment: z.record(z.string().min(1), z.string()).default({}),
  }),
  z.object({
    kind: z.literal("go-playground"),
    /**
     * Every Playground runtime carries this field, including the kinds whose
     * lessons have never used it. These objects are not strict, so a kind that
     * omitted it would have an authored `dockStartsCollapsed: true` stripped by
     * zod and render with the dock open — no error, no diagnostic, exactly the
     * invisible failure `runtimeDockStartsCollapsed` exists to prevent.
     */
    dockStartsCollapsed: z.boolean().default(false),
    defaultMode: z.enum(["live", "fixture"]),
    fixture: goRunFixtureSchema,
  }),
  z.object({
    kind: z.literal("kotlin-playground"),
    dockStartsCollapsed: z.boolean().default(false),
    defaultMode: z.enum(["live", "fixture"]),
    fixture: kotlinRunFixtureSchema,
  }),
  z.object({
    kind: z.literal("rust-playground"),
    dockStartsCollapsed: z.boolean().default(false),
    defaultMode: z.enum(["live", "fixture"]),
    fixture: rustRunFixtureSchema,
  }),
  z.object({
    kind: z.literal("zig-playground"),
    /**
     * Same reason as Kite: a Zig lesson that spends its first minutes on the
     * whiteboard should not hold 288px open for an empty console until the
     * first run.
     */
    dockStartsCollapsed: z.boolean().default(false),
    defaultMode: z.enum(["live", "fixture"]),
    fixture: zigRunFixtureSchema,
  }),
  z.object({
    kind: z.literal("haskell-playground"),
    /**
     * Same reason as Kite and Zig: a Haskell lesson usually spends its opening
     * minutes on types and laws before it runs anything, and should not hold
     * 288px open over an empty console to do it.
     */
    dockStartsCollapsed: z.boolean().default(false),
    defaultMode: z.enum(["live", "fixture"]),
    fixture: haskellRunFixtureSchema,
  }),
  z.object({
    kind: z.literal("kite-playground"),
    /**
     * The dock opens expanded, and a Kite lesson that runs nothing until its
     * last scenes pays 288px of editor for an empty console the whole way
     * there. Declaring it shut is pinned by the render before the recording
     * clock starts — frame one, no visible collapse — and `runtime.run` opens
     * it again when there is finally output to read.
     */
    dockStartsCollapsed: z.boolean().default(false),
    defaultMode: z.enum(["live", "fixture"]),
    fixture: kiteRunFixtureSchema,
  }),
  z.object({
    kind: z.literal("asm-playground"),
    /**
     * Same reason as Kite and Zig: an assembly lesson that draws the register
     * file on the whiteboard before writing a line should not hold 288px open
     * over an empty console to do it.
     */
    dockStartsCollapsed: z.boolean().default(false),
    defaultMode: z.enum(["live", "fixture"]),
    fixture: asmRunFixtureSchema,
  }),
]);
export type StudioRuntime = z.infer<typeof studioRuntimeSchema>;
export type StudioRuntimeKind = StudioRuntime["kind"];
export type StudioRuntimeMode = "live" | "fixture";

/**
 * The runtimes that execute code through a Playground engine rather than the
 * WebContainer: they have a Run button, a console, and a pinned run fixture.
 *
 * Derived from that last property rather than listed, so a Playground language
 * added to `studioRuntimeSchema` later joins this union on its own — neither
 * `webcontainer` (adapter config, no fixture) nor `none` carries one.
 */
export type StudioPlaygroundRuntime = Extract<StudioRuntime, { fixture: unknown }>;
export type StudioPlaygroundRuntimeKind = StudioPlaygroundRuntime["kind"];

/**
 * Whether a Playground kind executes through a proxied `/api/<kind>` route,
 * which a live render needs a signed-in session for. Kite and asm compile and
 * run in the page, so they call nothing and must stay `false` — gating them
 * would lock a lesson behind a sign-in it has no service to authenticate with.
 *
 * A `Record` over every kind rather than a chain or a `Set`: a Playground
 * language added to `studioRuntimeSchema` without a decision here fails the
 * typecheck, instead of quietly passing preflight and dying mid-performance at
 * `runtime.run` — the same failure shape `isPlaygroundRuntimeKind` exists to
 * prevent one layer up. It doubles as the list of Playground kinds, so there is
 * one place a new language has to be named rather than two that can disagree.
 */
const PLAYGROUND_RUNTIME_NEEDS_SESSION: Record<StudioPlaygroundRuntimeKind, boolean> = {
  "go-playground": true,
  "kotlin-playground": true,
  "rust-playground": true,
  "zig-playground": true,
  "haskell-playground": true,
  "kite-playground": false,
  "asm-playground": false,
};

const PLAYGROUND_RUNTIME_KINDS = new Set<string>(Object.keys(PLAYGROUND_RUNTIME_NEEDS_SESSION));

/**
 * Whether a runtime kind runs code on a Playground engine.
 *
 * Callers ask here instead of spelling the kinds out again. A hand-written
 * `kind !== "go-playground" && …` chain silently excludes any kind added later,
 * and the render failure it produces blames the script ("runtime.run requires a
 * Playground runtime") rather than the chain — which is exactly how
 * `kite-playground` shipped with a Run action it could never perform.
 */
export function isPlaygroundRuntimeKind(kind: string): kind is StudioPlaygroundRuntimeKind {
  return PLAYGROUND_RUNTIME_KINDS.has(kind);
}

/** Whether a live render of this runtime kind needs a signed-in session. */
export function runtimeNeedsSession(kind: string): boolean {
  return isPlaygroundRuntimeKind(kind) && PLAYGROUND_RUNTIME_NEEDS_SESSION[kind];
}

/**
 * The same question asked about a whole runtime, which is what a caller needs
 * to hand it to the Playground engine: narrowing `runtime.kind` alone does not
 * narrow `runtime`, so the fixture stays invisible to the type checker.
 */
export function isPlaygroundRuntime(runtime: StudioRuntime): runtime is StudioPlaygroundRuntime {
  return isPlaygroundRuntimeKind(runtime.kind);
}

/**
 * Whether a plan asks for the runner dock to start shut.
 *
 * Derived from the runtime carrying the field rather than from a list of kinds
 * that do. A hand-written `kind === "kite-playground" || kind ===
 * "zig-playground"` chain silently ignores any kind added later, and the
 * failure is invisible: the lesson renders, the dock is simply open when the
 * script said shut. That is the same shape of bug `isPlaygroundRuntimeKind`
 * exists to prevent one layer up.
 */
export function runtimeDockStartsCollapsed(runtime: StudioRuntime): boolean {
  return "dockStartsCollapsed" in runtime && runtime.dockStartsCollapsed;
}

export interface RuntimeModeParam {
  /** The requested mode, or null when no usable `runtime` value was supplied. */
  mode: StudioRuntimeMode | null;
  /** True when a non-empty `runtime` value was supplied that is neither allowed value. */
  invalid: boolean;
  /** The raw value, echoed back for error messages. */
  raw: string | null;
}

/**
 * Parse the `runtime` query parameter the /studio route and the studio-render
 * CLI both document as `fixture | live`. A missing (or empty) param yields
 * `mode: null` so the caller uses the plan's pinned default; an unrecognized
 * value is surfaced as `invalid` rather than silently coerced to the default —
 * otherwise a caller who explicitly asked for `fixture` could be forced onto a
 * plan whose default is `live`, contacting the real service (STUDIO-05).
 */
export function parseRuntimeModeParam(raw: string | null): RuntimeModeParam {
  if (raw === "live" || raw === "fixture") {
    return { mode: raw, invalid: false, raw };
  }
  return { mode: null, invalid: raw !== null && raw !== "", raw };
}

/**
 * The one runtime kind each lesson type may declare. Go, Kotlin, Rust, Zig,
 * and Haskell execute through their selective proxies, Kite on its in-page
 * WebAssembly compiler, asm on its in-page TypeScript assembler and x86-64
 * machine; JavaScript, TypeScript, and
 * Python all run in the versioned WebContainer adapter. JS/TS drive a dev server
 * + preview; Python runs one-shot on the WebContainer's built-in WASI `python3`
 * (no server, no preview) and gates on console `expect.output` — the per-lesson
 * action rules are enforced in the plan schema's superRefine below.
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

export const studioPlanSchema = z
  .object({
    schemaVersion: z.literal(STUDIO_PLAN_SCHEMA_VERSION),
    lesson: z.object({
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      title: z.string().min(1),
      locale: z.string().min(1),
    }),
    /** Seed the generated durations were derived from (recorded for provenance). */
    seed: z.number().int().nonnegative(),
    workspace: studioWorkspacePinSchema,
    slides: z.array(studioSlideSchema).default([]),
    whiteboardAssets: z.array(studioWhiteboardAssetSchema).default([]),
    narration: studioNarrationSchema,
    runtime: studioRuntimeSchema,
    /** Optional per-plan QA thresholds beyond the always-on artifact gates. */
    gates: z
      .object({
        /** Max tolerated p95 of |actual − planned| action starts (ms). */
        timingP95MaxMs: z.number().finite().positive().optional(),
      })
      .optional(),
    /**
     * afterAction dependencies (dependent id → predecessor id). The compiler
     * emits an entry for every action anchored `afterAction`. Deterministic
     * typing/selection chains carry modeled planned times; runtime and preview
     * waits cannot. In both cases the timing gate measures a dependent's drift
     * from its predecessor's actual acknowledgement. Without this a
     * WebContainer chain (runtime.start → waitForReady → preview.open) fails the
     * timing gate by construction, since dependency install/readiness time is
     * unbounded and unknowable at compile time (STUDIO-03).
     */
    dependencies: z.record(z.string(), z.string()).optional(),
    actions: z.array(studioPlanActionSchema).min(1),
  })
  .superRefine((plan, ctx) => {
    const expectedKind = RUNTIME_KIND_FOR_LESSON[plan.workspace.lessonType];
    if (plan.runtime.kind !== expectedKind) {
      ctx.addIssue({
        code: "custom",
        message: `Lesson type "${plan.workspace.lessonType}" requires runtime kind "${expectedKind}", got "${plan.runtime.kind}"`,
      });
    }
    if (plan.runtime.kind === "none") {
      for (const action of plan.actions) {
        if (
          action.type === "runtime.run" ||
          action.type === "runtime.start" ||
          action.type === "runtime.waitForReady" ||
          action.type.startsWith("preview.") ||
          action.type === "expect.preview" ||
          action.type === "expect.output"
        ) {
          ctx.addIssue({
            code: "custom",
            message: `Action "${action.id}" (${action.type}) needs a runnable runtime, but lesson type "${plan.workspace.lessonType}" has none in the studio yet`,
          });
        }
      }
    }
    if (plan.runtime.kind === "webcontainer") {
      // Python runs one-shot on the WebContainer's WASI `python3`: no package
      // install (so no lockfile), no dev server, no preview. JS/TS drive a dev
      // server + preview and must pin a lockfile for a reproducible install.
      const isPython = plan.workspace.lessonType === "python";
      if (plan.runtime.lockfilePath === undefined) {
        if (!isPython) {
          ctx.addIssue({
            code: "custom",
            message: `A ${plan.workspace.lessonType} WebContainer lesson must pin a lockfilePath for a reproducible install`,
          });
        }
      } else if (!(plan.runtime.lockfilePath in plan.workspace.files)) {
        ctx.addIssue({
          code: "custom",
          message: `WebContainer lockfile "${plan.runtime.lockfilePath}" is not in the pinned workspace`,
        });
      }
      if (isPython) {
        if (plan.runtime.lockfilePath !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: "A Python WebContainer lesson must omit lockfilePath (nothing is installed)",
          });
        }
        if (plan.runtime.expectedPort !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: "A Python WebContainer lesson must omit expectedPort (it has no server)",
          });
        }
        if (plan.runtime.initCommand.trim() !== "") {
          ctx.addIssue({
            code: "custom",
            message: "A Python WebContainer lesson must use an empty initCommand",
          });
        }
        if (!/^python3(?:\s|$)/.test(plan.runtime.runCommand.trim())) {
          ctx.addIssue({
            code: "custom",
            message: 'A Python WebContainer lesson runCommand must invoke "python3"',
          });
        }
      }
      for (const action of plan.actions) {
        if (action.type === "runtime.run") {
          ctx.addIssue({
            code: "custom",
            message: `Action "${action.id}" (runtime.run) is a Playground command; a WebContainer lesson runs via runtime.start`,
          });
        }
        if (isPython) {
          // WASI Python cannot bind a socket, so it has no server to wait for and
          // no preview to interact with — it asserts through console expect.output.
          if (
            action.type === "runtime.waitForReady" ||
            action.type.startsWith("preview.") ||
            action.type === "expect.preview"
          ) {
            ctx.addIssue({
              code: "custom",
              message: `Action "${action.id}" (${action.type}) needs a preview server; Python runs one-shot to the console — assert with expect.output`,
            });
          }
        } else if (action.type === "expect.output") {
          ctx.addIssue({
            code: "custom",
            message: `Action "${action.id}" (expect.output) is for console runtimes; a ${plan.workspace.lessonType} preview lesson asserts with expect.preview`,
          });
        }
      }
    } else if (plan.runtime.kind !== "none") {
      for (const action of plan.actions) {
        if (
          action.type === "runtime.start" ||
          action.type === "runtime.waitForReady" ||
          action.type.startsWith("preview.") ||
          action.type === "expect.preview"
        ) {
          ctx.addIssue({
            code: "custom",
            message: `Action "${action.id}" (${action.type}) requires runtime kind "webcontainer"`,
          });
        }
      }
    }

    const ids = new Set<string>();
    for (const action of plan.actions) {
      if (action.type === "preview.click" && action.retry.maxAttempts !== 1) {
        ctx.addIssue({
          code: "custom",
          message: `Action "${action.id}" is non-idempotent and must use retry.maxAttempts: 1`,
        });
      }
      if (
        action.type === "expect.preview" &&
        action.target === undefined &&
        action.route === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message: `Action "${action.id}" must declare a preview target or route expectation`,
        });
      }
      if (
        action.type === "expect.preview" &&
        action.target === undefined &&
        (action.textContains !== undefined ||
          action.value !== undefined ||
          action.attribute !== undefined)
      ) {
        ctx.addIssue({
          code: "custom",
          message: `Action "${action.id}" needs a stable target for text, value, or attribute checks`,
        });
      }
      if (ids.has(action.id)) {
        ctx.addIssue({ code: "custom", message: `Duplicate action id "${action.id}"` });
      }
      ids.add(action.id);
    }

    if (plan.dependencies) {
      const indexById = new Map(plan.actions.map((action, index) => [action.id, index]));
      for (const [dependentId, predecessorId] of Object.entries(plan.dependencies)) {
        const dependentIndex = indexById.get(dependentId);
        const predecessorIndex = indexById.get(predecessorId);
        if (dependentIndex === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `Dependency for unknown action "${dependentId}"`,
          });
        } else if (predecessorIndex === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `Action "${dependentId}" depends on unknown action "${predecessorId}"`,
          });
        } else if (predecessorIndex >= dependentIndex) {
          ctx.addIssue({
            code: "custom",
            message: `Action "${dependentId}" depends on "${predecessorId}", which does not precede it`,
          });
        }
      }
    }

    for (let i = 1; i < plan.actions.length; i++) {
      if (plan.actions[i].at < plan.actions[i - 1].at) {
        ctx.addIssue({
          code: "custom",
          message: `Action "${plan.actions[i].id}" is scheduled before its predecessor (${plan.actions[i].at} < ${plan.actions[i - 1].at})`,
        });
      }
    }

    for (const action of plan.actions) {
      if (action.type === "workspace.openFile" || action.type === "expect.file") {
        if (!(action.path in plan.workspace.files)) {
          ctx.addIssue({
            code: "custom",
            message: `Action "${action.id}" references "${action.path}" which is not in the pinned workspace`,
          });
        }
      }
      if (action.type === "editor.type" && !(action.path in plan.workspace.files)) {
        ctx.addIssue({
          code: "custom",
          message: `Action "${action.id}" types into "${action.path}" which is not in the pinned workspace`,
        });
      }
      if (action.type === "editor.select" && !(action.path in plan.workspace.files)) {
        ctx.addIssue({
          code: "custom",
          message: `Action "${action.id}" selects in "${action.path}" which is not in the pinned workspace`,
        });
      }
      if (action.type === "cursor.moveTo" && action.target.kind === "file") {
        if (!(action.target.path in plan.workspace.files)) {
          ctx.addIssue({
            code: "custom",
            message: `Action "${action.id}" points the cursor at missing file "${action.target.path}"`,
          });
        }
      }
      if (action.type === "slide.show") {
        if (!plan.slides.some((slide) => slide.id === action.slideId)) {
          ctx.addIssue({
            code: "custom",
            message: `Action "${action.id}" shows slide "${action.slideId}" which is not a pinned slide asset`,
          });
        }
      }
      if (action.type === "whiteboard.apply") {
        for (const assetId of action.upsertIds) {
          if (!plan.whiteboardAssets.some((asset) => asset.id === assetId)) {
            ctx.addIssue({
              code: "custom",
              message: `Action "${action.id}" upserts whiteboard asset "${assetId}" which is not pinned`,
            });
          }
        }
      }
    }

    // A timed action must fit between its start and the next scheduled action:
    // the Performer is sequential, so a later action scheduled before this one
    // can finish is an impossible overlap (§5). Typing spends its chunk delays,
    // a select spends its drag-glide duration, and a drawn whiteboard apply
    // spends one 20 fps frame budget per sequential asset.
    for (let i = 0; i < plan.actions.length; i++) {
      const action = plan.actions[i];
      const busyMs =
        action.type === "editor.type"
          ? action.chunks.reduce((total, chunk) => total + chunk.delayMs, 0)
          : action.type === "editor.select"
            ? action.durationMs
            : action.type === "whiteboard.apply"
              ? whiteboardDrawDurationMs(action.upsertIds.length, action.drawMs)
              : 0;
      if (busyMs === 0) continue;
      const next = plan.actions[i + 1];
      if (next && action.at + busyMs > next.at) {
        const label =
          action.type === "editor.type"
            ? "Typing"
            : action.type === "editor.select"
              ? "Selection"
              : "Whiteboard drawing";
        ctx.addIssue({
          code: "custom",
          message: `${label} action "${action.id}" (${busyMs}ms) overlaps "${next.id}" at ${next.at}ms`,
        });
      }
    }

    // `actions` is required to be non-empty, but that is a *continuable* check —
    // Zod still runs this refinement with an empty array — so the last-action read
    // below must not assume one exists, or a plan compiled from an action-less
    // lesson fails with a TypeError instead of the schema's own message.
    const lastAction = plan.actions.at(-1);
    if (lastAction && lastAction.at >= plan.narration.expectedDurationMs) {
      ctx.addIssue({
        code: "custom",
        message: `Action "${lastAction.id}" starts after the narration ends; the recording stops with the audio`,
      });
    }

    const { cues } = plan.narration.captions;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      if (cue.end <= cue.start) {
        ctx.addIssue({ code: "custom", message: `Caption cue ${i} ends before it starts` });
      }
      if (i > 0 && cue.start < cues[i - 1].end) {
        ctx.addIssue({ code: "custom", message: `Caption cue ${i} overlaps cue ${i - 1}` });
      }
      for (const word of cue.words ?? []) {
        if (word.end < word.start || word.start < cue.start || word.end > cue.end) {
          ctx.addIssue({
            code: "custom",
            message: `Caption cue ${i} has a word outside its cue bounds`,
          });
        }
      }
    }
  });

export type StudioPlan = z.infer<typeof studioPlanSchema>;

/** Parse + validate a candidate plan, throwing a readable error on failure. */
export function parseStudioPlan(candidate: unknown): StudioPlan {
  const result = studioPlanSchema.safeParse(candidate);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(plan)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid studio plan: ${details}`);
  }
  return result.data;
}

export function planCaptionTrack(plan: StudioPlan): CaptionTrack {
  return plan.narration.captions;
}
