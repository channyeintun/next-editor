import { z } from "zod";
import { parseAsmPlaygroundRunResult } from "../runtime/asmPlayground/types";
import { parseGoPlaygroundRunResult } from "../runtime/goPlayground/types";
import { parseHaskellPlaygroundRunResult } from "../runtime/haskellPlayground/types";
import { parseKitePlaygroundRunResult } from "../runtime/kitePlayground/types";
import { parseKotlinPlaygroundRunResult } from "../runtime/kotlinPlayground/types";
import { parseRustPlaygroundRunResult } from "../runtime/rustPlayground/types";
import { parseZigPlaygroundRunResult } from "../runtime/zigPlayground/types";
import { totalTypingDurationMs } from "./cadence";
import {
  actionContractIssues,
  pinnedReferenceIssues,
  runtimeContractIssues,
  type PinnedReference,
} from "./runtimeContract";
import { whiteboardDrawDurationMs } from "./whiteboardAssets";

/**
 * Compiled lesson plan — the deterministic contract between the Director (asset
 * build) and the in-app Performer (docs/agent-lesson-production.md §4/§5).
 *
 * Plans are never authored or checked in: the in-page Director compiles one
 * from a LessonScript YAML at render time (inPageDirector → compileLessonScript)
 * and validates it with this schema. Nothing here may depend on narration
 * markers or wall-clock times. Every `at` is an absolute millisecond offset on
 * the recording clock, and every generated duration (typing chunk delays,
 * cursor tween lengths) is already materialized so performing the same plan
 * twice never re-rolls them.
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

/** Hard deadline for an action to acknowledge; the render fails closed past it. */
export const studioActionTimeoutMsSchema = positiveMs.default(10_000);

const planActionBase = z.object({
  /** Unique, stable action id — receipts and reports key off it. */
  id: z.string().min(1),
  /** Absolute planned start time on the recording clock (ms). */
  at: nonNegativeMs,
  timeoutMs: studioActionTimeoutMsSchema,
});

/** Durable UI target reference. Missing targets are render failures, never guesses. */
export const studioTargetRefSchema = z.union([
  z.object({ kind: z.literal("file"), path: z.string().min(1) }),
  z.object({ kind: z.literal("editor") }),
  z.object({ kind: z.literal("run-button") }),
  z.object({ kind: z.literal("target-id"), id: z.string().min(1) }),
  /** An author-owned `data-testid` element inside the runtime preview frame. */
  z.object({ kind: z.literal("preview"), testId: z.string().min(1) }),
]);
export type StudioTargetRef = z.infer<typeof studioTargetRefSchema>;

/** Stable author-owned target inside a cross-origin runtime preview. */
export const studioPreviewTargetSchema = z.object({
  by: z.literal("testId"),
  value: z.string().min(1),
});
export type StudioPreviewTarget = z.infer<typeof studioPreviewTargetSchema>;

/** An attribute an `expect.preview` checks on its target. */
export const studioPreviewAttributeSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
});

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

/**
 * The payload of every action a script author writes and the plan then carries
 * as it is — its fields, defaults and bounds, declared once. The plan builds
 * its action schemas from these shapes and the script schema builds its own,
 * so a field added or a bound changed here reaches both; when each schema
 * declared its own copy, every change had to be made twice.
 *
 * Only the nested objects come in: the script passes `.strict()` variants, so
 * a typo inside an authored target still fails, while the plan keeps zod's
 * default. `editor.type`, `editor.select` and `console.point` are not here —
 * the author writes a target the compiler turns into a different plan payload.
 */
export function studioActionFieldShapes<
  Retry extends z.ZodType<StudioRetryPolicy>,
  PreviewTarget extends z.ZodType<StudioPreviewTarget>,
  Attribute extends z.ZodType<z.infer<typeof studioPreviewAttributeSchema>>,
>({
  retry,
  previewTarget,
  attribute,
}: {
  retry: Retry;
  previewTarget: PreviewTarget;
  attribute: Attribute;
}) {
  return {
    "workspace.openFile": { path: z.string().min(1) },
    "runtime.run": {},
    "runtime.start": { retry },
    "runtime.waitForReady": { retry },
    // `runtime.run` opens the runner dock and nothing closes it again, so it
    // sits over the editor through the explanation that follows. This hands
    // that back to the author: collapse it once the output has been read — or
    // before a single line has been typed, so the dock costs a tab strip
    // instead of 288px until there is finally something in it.
    "runtime.collapseDock": {},
    "preview.open": { mode: z.enum(["docked", "floating"]).default("docked"), retry },
    "preview.click": { target: previewTarget, retry },
    "preview.input": { target: previewTarget, value: z.string(), retry },
    "preview.scroll": {
      target: previewTarget.optional(),
      top: z.number().finite(),
      left: z.number().finite().default(0),
      retry,
    },
    "preview.route": { route: z.string().startsWith("/").min(1), retry },
    "slide.show": { slideId: z.string().min(1), maximized: z.boolean().default(true) },
    "slide.close": {},
    "whiteboard.apply": {
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
    },
    "expect.output": { contains: z.string().min(1) },
    "expect.file": { path: z.string().min(1), contains: z.string().min(1) },
    "expect.preview": {
      target: previewTarget.optional(),
      textContains: z.string().min(1).optional(),
      value: z.string().optional(),
      route: z.string().startsWith("/").min(1).optional(),
      attribute: attribute.optional(),
      retry,
    },
  };
}

/** The `whiteboard.apply` fields its two cross-field rules read. */
interface WhiteboardApplyRuleFields {
  open?: boolean;
  maximized?: boolean;
  upsertIds: readonly string[];
  clear: boolean;
  drawMs: number;
  timeoutMs: number;
}

/**
 * The cross-field rules of a `whiteboard.apply`, on both schemas: the script
 * checks them so an apply that does nothing fails when the script is parsed,
 * not at compile time after the narration is synthesized.
 */
export function withWhiteboardApplyRules<Schema extends z.ZodType<WhiteboardApplyRuleFields>>(
  schema: Schema,
): Schema {
  return schema
    .refine(
      (action: WhiteboardApplyRuleFields) =>
        action.open !== undefined ||
        action.maximized !== undefined ||
        action.upsertIds.length > 0 ||
        action.clear,
      {
        message:
          "whiteboard.apply must open/close, change maximize, clear the board, or upsert at least one asset",
      },
    )
    .refine((action: WhiteboardApplyRuleFields) => action.drawMs < action.timeoutMs, {
      message: "whiteboard.apply drawMs must be shorter than the action's timeoutMs",
    });
}

const fields = studioActionFieldShapes({
  retry: studioRetryPolicySchema,
  previewTarget: studioPreviewTargetSchema,
  attribute: studioPreviewAttributeSchema,
});

const openFileActionSchema = planActionBase.extend({
  type: z.literal("workspace.openFile"),
  ...fields["workspace.openFile"],
});

const cursorMoveActionSchema = planActionBase.extend({
  type: z.literal("cursor.moveTo"),
  target: studioTargetRefSchema,
  /**
   * Whole budget: the travel (the driver times it from the real distance and
   * starts later when it needs less) plus, with `press`, the settle and click.
   */
  durationMs: positiveMs,
  /** End on a click — rest on the target, press, release — as a hand operating the control. */
  press: z.boolean().optional(),
});

const editorTypeActionSchema = planActionBase.extend({
  type: z.literal("editor.type"),
  path: z.string().min(1),
  anchor: textAnchorSchema,
  /** Materialized chunk schedule; total typing time is the sum of delays. */
  chunks: z.array(typingChunkSchema).min(1),
});

/**
 * A console line to point at: the `occurrence`-th line containing `text` in
 * the latest run's output (one line — the text never spans a line break).
 */
export const consoleLineTargetSchema = z.object({
  text: z
    .string()
    .min(1)
    .refine((text) => !text.includes("\n"), "A console line target is one line of text")
    .refine(
      (text) => !text.includes("\t"),
      "The console shows a tab as spaces up to the next 8-column stop — target text without a tab, or write the spaces the console shows",
    ),
  occurrence: z.number().int().min(1).default(1),
});
export type ConsoleLineTarget = z.infer<typeof consoleLineTargetSchema>;

const consolePointActionSchema = planActionBase.extend({
  type: z.literal("console.point"),
  target: consoleLineTargetSchema,
  /** Travel budget toward the line; the driver moves for what the distance needs. */
  durationMs: positiveMs,
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
  ...fields["runtime.run"],
});

const runtimeStartActionSchema = planActionBase.extend({
  type: z.literal("runtime.start"),
  ...fields["runtime.start"],
});

const runtimeWaitForReadyActionSchema = planActionBase.extend({
  type: z.literal("runtime.waitForReady"),
  ...fields["runtime.waitForReady"],
});

const runtimeCollapseDockActionSchema = planActionBase.extend({
  type: z.literal("runtime.collapseDock"),
  ...fields["runtime.collapseDock"],
});

/**
 * Derived by the compiler, never authored: opens the shut runner dock, the way
 * its chevron does, between the pointer clicking that chevron and pressing the
 * Run button that only then appears.
 */
const runtimeExpandDockActionSchema = planActionBase.extend({
  type: z.literal("runtime.expandDock"),
});

const previewOpenActionSchema = planActionBase.extend({
  type: z.literal("preview.open"),
  ...fields["preview.open"],
});

const previewClickActionSchema = planActionBase.extend({
  type: z.literal("preview.click"),
  ...fields["preview.click"],
});

const previewInputActionSchema = planActionBase.extend({
  type: z.literal("preview.input"),
  ...fields["preview.input"],
});

const previewScrollActionSchema = planActionBase.extend({
  type: z.literal("preview.scroll"),
  ...fields["preview.scroll"],
});

const previewRouteActionSchema = planActionBase.extend({
  type: z.literal("preview.route"),
  ...fields["preview.route"],
});

const slideShowActionSchema = planActionBase.extend({
  type: z.literal("slide.show"),
  ...fields["slide.show"],
});

const slideCloseActionSchema = planActionBase.extend({
  type: z.literal("slide.close"),
  ...fields["slide.close"],
});

const whiteboardApplyActionSchema = withWhiteboardApplyRules(
  planActionBase.extend({
    type: z.literal("whiteboard.apply"),
    ...fields["whiteboard.apply"],
  }),
);

const expectOutputActionSchema = planActionBase.extend({
  type: z.literal("expect.output"),
  ...fields["expect.output"],
});

const expectFileActionSchema = planActionBase.extend({
  type: z.literal("expect.file"),
  ...fields["expect.file"],
});

const expectPreviewActionSchema = planActionBase.extend({
  type: z.literal("expect.preview"),
  ...fields["expect.preview"],
});

export const studioPlanActionSchema = z.discriminatedUnion("type", [
  openFileActionSchema,
  cursorMoveActionSchema,
  editorTypeActionSchema,
  editorSelectActionSchema,
  consolePointActionSchema,
  runtimeRunActionSchema,
  runtimeStartActionSchema,
  runtimeWaitForReadyActionSchema,
  runtimeCollapseDockActionSchema,
  runtimeExpandDockActionSchema,
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
 * The fields that decide how long an action keeps the Performer busy. Every
 * plan action is one; the Director builds one from a script action's
 * materialized chunks/durations (script/actionTiming.ts) before the plan exists.
 */
export type StudioActionTiming =
  | { type: "editor.type"; chunks: readonly TypingChunk[] }
  | { type: "editor.select" | "console.point"; durationMs: number }
  | { type: "whiteboard.apply"; upsertIds: readonly string[]; drawMs: number }
  | {
      type: Exclude<
        StudioPlanActionType,
        "editor.type" | "editor.select" | "console.point" | "whiteboard.apply"
      >;
    };

/**
 * How long an action keeps the sequential Performer busy before it can
 * acknowledge — the one rule behind the overlap gate, the Performer's
 * deadline and the Director's busy windows. Typing spends its chunk delays, a
 * select its drag-glide duration, pointing at a console line its travel
 * budget, and a drawn whiteboard apply one 20 fps frame per drawn step;
 * every other action owns its waits inside its timeout.
 */
export function planActionBusyMs(action: StudioActionTiming): number {
  switch (action.type) {
    case "editor.type":
      return totalTypingDurationMs(action.chunks);
    case "editor.select":
    case "console.point":
      return action.durationMs;
    case "whiteboard.apply":
      return whiteboardDrawDurationMs(action.upsertIds.length, action.drawMs);
    default:
      return 0;
  }
}

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
  /**
   * The whiteboard renders with Excalidraw's dark theme, which inverts
   * colours: #1e1e1e paints white, while a pale default like #e2e8f0 would
   * paint near-black on the dark canvas and all but vanish.
   */
  strokeColor: z.string().default("#1e1e1e"),
  backgroundColor: z.string().default("transparent"),
  /** 28px is the smallest label that stays readable in the recorded lesson. */
  fontSize: z.number().finite().positive().default(28),
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
  /**
   * Opaque identity of the synthesized narration (`studio-tts://<narrationKey>`),
   * covered by the plan hash. Never fetched: the in-page Director hands the
   * stitched audio to the render directly.
   */
  audioPath: z.string().min(1),
  mimeType: z.string().min(1),
  /** Expected narration length; the recorder still measures the real duration. */
  expectedDurationMs: positiveMs,
  captions: studioCaptionTrackSchema,
});

/**
 * A pinned result has to be one the live runner could actually return.
 *
 * Each `*RunFixtureSchema` below restates its language's result shape in zod,
 * which checks field types but not the cross-field invariants the runtime
 * contract enforces — that an assemble/compile error carries its diagnostics,
 * that a success carries none, that a program which never built has no exit
 * status. Every client already refuses a result that breaks them, through the
 * `parse*RunResult` its response goes through; the studio's fixture path skips
 * the client entirely and hands `fixture.result` straight to the console
 * formatter, so without this the plan would validate a pinned console no live
 * run can produce — the exact thing pinning a fixture exists to prevent.
 *
 * Calling the runtime module's own parser keeps one validator for both paths,
 * rather than a second copy of the rules here that can drift from it.
 */
function runnerContract(
  parse: (value: unknown) => unknown,
  label: string,
): (result: unknown, ctx: z.RefinementCtx) => void {
  return (result, ctx) => {
    if (parse(result) === null) {
      ctx.addIssue({
        code: "custom",
        message: `${label} fixture result does not match the runner contract`,
      });
    }
  };
}

/**
 * The service failures a server-backed Playground run retries — the transient
 * kinds a fixture may simulate, and the kinds the run engine treats as
 * retryable. The in-page runners (Kite, asm) can only be "unavailable".
 */
export const PLAYGROUND_TRANSIENT_ERROR_KINDS = ["rate-limited", "timeout", "unavailable"] as const;

/**
 * Deterministic stand-in for a live run: the exact normalized result the
 * Playground would return for the pinned sources. Fixture renders replay it
 * through the same console formatting path after `latencyMs`. Each language
 * keeps its own result schema; this factory owns the fields they all share.
 */
function playgroundFixture<
  TransientKinds extends readonly [string, ...string[]],
  Result extends z.ZodType,
>(transientKinds: TransientKinds, result: Result) {
  return z.object({
    latencyMs: positiveMs,
    /**
     * Transient service failures to simulate before the result, one per attempt
     * — exercises the driver's declared-idempotent retry path deterministically.
     */
    transientErrorKinds: z.array(z.enum(transientKinds)).default([]),
    result,
  });
}

/** Go Playground stand-in result — mirrors the worker-normalized contract. */
export const goRunFixtureSchema = playgroundFixture(
  PLAYGROUND_TRANSIENT_ERROR_KINDS,
  z
    .object({
      status: z.enum(["success", "compile-error", "vet-error", "runtime-error"]),
      output: z.string(),
      compileErrors: z.string().optional(),
      vetErrors: z.string().optional(),
      exitCode: z.number().int().optional(),
    })
    .superRefine(runnerContract(parseGoPlaygroundRunResult, "Go")),
);

/** Kotlin Playground stand-in result — mirrors the worker-normalized contract. */
export const kotlinRunFixtureSchema = playgroundFixture(
  PLAYGROUND_TRANSIENT_ERROR_KINDS,
  z
    .object({
      status: z.enum(["success", "compile-error", "runtime-error"]),
      output: z.string(),
      compileErrors: z.string().optional(),
      warnings: z.string().optional(),
      exception: z.string().optional(),
    })
    .superRefine(runnerContract(parseKotlinPlaygroundRunResult, "Kotlin")),
);

/**
 * Zig's fixture result shape differs from the others by one field: zig-play.dev
 * runs the program with its streams merged and answers in text/plain, so there
 * is no stdout/stderr split to pin. Pinning two fields where the service
 * reports one would invite a fixture that no live run could ever reproduce.
 */
export const zigRunFixtureSchema = playgroundFixture(
  PLAYGROUND_TRANSIENT_ERROR_KINDS,
  z
    .object({
      status: z.enum(["success", "compile-error", "runtime-error"]),
      output: z.string(),
      compileErrors: z.string().optional(),
      exitDetail: z.string().optional(),
    })
    .superRefine(runnerContract(parseZigPlaygroundRunResult, "Zig")),
);

/** Rust Playground stand-in result — mirrors the worker-normalized contract. */
export const rustRunFixtureSchema = playgroundFixture(
  PLAYGROUND_TRANSIENT_ERROR_KINDS,
  z
    .object({
      status: z.enum(["success", "compile-error", "runtime-error"]),
      stdout: z.string(),
      stderr: z.string(),
      compileErrors: z.string().optional(),
      exitDetail: z.string().optional(),
    })
    .superRefine(runnerContract(parseRustPlaygroundRunResult, "Rust")),
);

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
export const haskellRunFixtureSchema = playgroundFixture(
  PLAYGROUND_TRANSIENT_ERROR_KINDS,
  z
    .object({
      status: z.enum(["success", "compile-error", "runtime-error"]),
      stdout: z.string(),
      stderr: z.string(),
      compileErrors: z.string().optional(),
      warnings: z.string().optional(),
      exitDetail: z.string().optional(),
    })
    .superRefine(runnerContract(parseHaskellPlaygroundRunResult, "Haskell")),
);

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
 * also carries the register file, so a fixture that omits `registers` replays a
 * run with no register lines, and one that includes them replays them exactly.
 * `flags` and `instructions` are pinned but not rendered: only `registers` has
 * a console line today (`asmRegisterConsoleLines`), and the runner panel
 * carries the other two for the same reason this schema does — so a fixture
 * that grows a flag line later already holds the values it needs.
 */
export const asmRunFixtureSchema = playgroundFixture(
  ["unavailable"] as const,
  z
    .object({
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
    })
    .superRefine(runnerContract(parseAsmPlaygroundRunResult, "Assembly")),
);

/**
 * Kite stand-in result.
 *
 * The only transient error kind is "unavailable": Kite's compiler is
 * WebAssembly running in the page, so a lesson cannot be rate-limited or timed
 * out by a service it does not call.
 */
export const kiteRunFixtureSchema = playgroundFixture(
  ["unavailable"] as const,
  z
    .object({
      status: z.enum(["success", "compile-error", "runtime-error"]),
      stdout: z.string(),
      stderr: z.string(),
      compileErrors: z.string().optional(),
      exitDetail: z.string().optional(),
    })
    .superRefine(runnerContract(parseKitePlaygroundRunResult, "Kite")),
);

/**
 * One Playground runtime variant, so every kind carries the same fields.
 *
 * `dockStartsCollapsed` in particular is not optional per kind: these objects
 * are not strict, so a variant that omitted it would have an authored
 * `dockStartsCollapsed: true` stripped by zod and render with the dock open —
 * no error, no diagnostic, exactly the invisible failure
 * `runtimeDockStartsCollapsed` exists to prevent.
 */
function playgroundRuntime<Kind extends string, Fixture extends z.ZodType>(
  kind: Kind,
  fixture: Fixture,
) {
  return z.object({
    kind: z.literal(kind),
    /**
     * The dock opens expanded, and a lesson that runs nothing until its last
     * scenes pays 288px of editor for an empty console the whole way there —
     * a Kite or Zig lesson that opens on the whiteboard, a Haskell lesson on
     * types and laws, an assembly lesson drawing the register file. Declaring
     * it shut is pinned by the render before the recording clock starts —
     * frame one, no visible collapse — and `runtime.run` opens it again when
     * there is finally output to read.
     */
    dockStartsCollapsed: z.boolean().default(false),
    defaultMode: z.enum(["live", "fixture"]),
    fixture,
  });
}

/**
 * Execution-kind-specific runtime declaration. "live" calls the real
 * /api/<kind> proxy (no sign-in needed) or the in-page compiler; "fixture"
 * replays the pinned result. Unattended renders default to the plan's declared
 * mode; the manifest records which one ran. Kind "webcontainer" is the versioned JS/TS
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
     * `python3` with no package install (validated per lessonType in
     * runtimeContract.ts).
     */
    lockfilePath: z.string().min(1).optional(),
    environment: z.record(z.string().min(1), z.string()).default({}),
  }),
  playgroundRuntime("go-playground", goRunFixtureSchema),
  playgroundRuntime("kotlin-playground", kotlinRunFixtureSchema),
  playgroundRuntime("rust-playground", rustRunFixtureSchema),
  playgroundRuntime("zig-playground", zigRunFixtureSchema),
  playgroundRuntime("haskell-playground", haskellRunFixtureSchema),
  playgroundRuntime("kite-playground", kiteRunFixtureSchema),
  playgroundRuntime("asm-playground", asmRunFixtureSchema),
]);
export type StudioRuntime = z.infer<typeof studioRuntimeSchema>;
export type StudioRuntimeKind = StudioRuntime["kind"];
export type StudioRuntimeMode = "live" | "fixture";

/**
 * The mode a render uses when `?runtime=` does not choose one. Lessons without
 * a runnable runtime execute fully locally; "fixture" is the honest label for
 * that.
 */
export function defaultRuntimeModeOf(runtime: StudioRuntime): StudioRuntimeMode {
  return runtime.kind === "none" ? "fixture" : runtime.defaultMode;
}

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
 * Every Playground kind, named once. A `Record` over the kinds rather than a
 * plain list: a Playground language added to `studioRuntimeSchema` without
 * being named here fails the typecheck, instead of quietly failing
 * `isPlaygroundRuntimeKind` and dying mid-performance at `runtime.run`.
 *
 * None of these needs a signed-in session for a live render. Go, Kotlin, Rust,
 * Zig and Haskell call their `/api/<kind>` proxy, which needs no sign-in; Kite
 * and asm compile and run in the page.
 */
const PLAYGROUND_RUNTIME_KIND_TABLE: Record<StudioPlaygroundRuntimeKind, true> = {
  "go-playground": true,
  "kotlin-playground": true,
  "rust-playground": true,
  "zig-playground": true,
  "haskell-playground": true,
  "kite-playground": true,
  "asm-playground": true,
};

const PLAYGROUND_RUNTIME_KINDS = new Set<string>(Object.keys(PLAYGROUND_RUNTIME_KIND_TABLE));

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

/** The pinned files, slides and whiteboard assets a plan action names. */
function planPinnedReferences(action: StudioPlanAction): PinnedReference[] {
  switch (action.type) {
    case "workspace.openFile":
    case "expect.file":
      return [{ id: action.id, kind: "file", value: action.path, verb: "references" }];
    case "editor.type":
      return [{ id: action.id, kind: "file", value: action.path, verb: "types into" }];
    case "editor.select":
      return [{ id: action.id, kind: "file", value: action.path, verb: "selects in" }];
    case "slide.show":
      return [{ id: action.id, kind: "slide", value: action.slideId }];
    case "whiteboard.apply":
      return action.upsertIds.map((assetId) => ({
        id: action.id,
        kind: "whiteboard-asset",
        value: assetId,
      }));
    default:
      return [];
  }
}

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
    /** Chapter starts, from the scenes that title one; attached to the finished recording. */
    chapters: z
      .array(z.object({ time: z.number().finite().nonnegative(), title: z.string().min(1) }))
      .default([]),
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
    for (const message of runtimeContractIssues(plan.workspace, plan.runtime, plan.actions)) {
      ctx.addIssue({ code: "custom", message });
    }
    for (const message of actionContractIssues(plan.actions)) {
      ctx.addIssue({ code: "custom", message });
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

    const pins = {
      files: plan.workspace.files,
      slides: plan.slides,
      whiteboardAssets: plan.whiteboardAssets,
    };
    for (const action of plan.actions) {
      for (const message of pinnedReferenceIssues(pins, planPinnedReferences(action))) {
        ctx.addIssue({ code: "custom", message });
      }
      if (action.type === "cursor.moveTo" && action.target.kind === "file") {
        if (!(action.target.path in plan.workspace.files)) {
          ctx.addIssue({
            code: "custom",
            message: `Action "${action.id}" points the cursor at missing file "${action.target.path}"`,
          });
        }
      }
    }

    // A timed action must fit between its start and the next scheduled action:
    // the Performer is sequential, so a later action scheduled before this one
    // can finish is an impossible overlap (§5).
    for (let i = 0; i < plan.actions.length; i++) {
      const action = plan.actions[i];
      const busyMs = planActionBusyMs(action);
      if (busyMs === 0) continue;
      const next = plan.actions[i + 1];
      if (next && action.at + busyMs > next.at) {
        const label =
          action.type === "editor.type"
            ? "Typing"
            : action.type === "editor.select"
              ? "Selection"
              : action.type === "console.point"
                ? "Pointing"
                : "Whiteboard drawing";
        ctx.addIssue({
          code: "custom",
          message: `${label} action "${action.id}" (${busyMs}ms) overlaps "${next.id}" at ${next.at}ms`,
          params: { timeline: true },
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
        params: { timeline: true },
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

/**
 * A candidate plan that failed validation. `issues` lets a caller tell kinds of
 * failure apart without reading the message: the two timeline issues — a busy
 * action running into the next one, the last action starting after the
 * narration ends — carry `params.timeline`.
 */
export class StudioPlanError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(message: string, issues: z.core.$ZodIssue[]) {
    super(message);
    this.name = "StudioPlanError";
    this.issues = issues;
  }
}

/** Whether a plan issue is one of the timeline failures marks and offsets can fix. */
export function isTimelineIssue(issue: z.core.$ZodIssue): boolean {
  return issue.code === "custom" && issue.params?.timeline === true;
}

/** Parse + validate a candidate plan, throwing a readable error on failure. */
export function parseStudioPlan(candidate: unknown): StudioPlan {
  const result = studioPlanSchema.safeParse(candidate);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(plan)"}: ${issue.message}`)
      .join("; ");
    throw new StudioPlanError(`Invalid studio plan: ${details}`, result.error.issues);
  }
  return result.data;
}
