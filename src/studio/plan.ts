import { z } from "zod";
import type { CaptionTrack } from "../core/src/types";

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
  })
  .refine(
    (action) =>
      action.open !== undefined || action.maximized !== undefined || action.upsertIds.length > 0,
    { message: "whiteboard.apply must open/close, change maximize, or upsert at least one asset" },
  );

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
  attribute: z
    .object({ name: z.string().min(1), value: z.string() })
    .optional(),
  retry: studioRetryPolicySchema,
});

export const studioPlanActionSchema = z.discriminatedUnion("type", [
  openFileActionSchema,
  cursorMoveActionSchema,
  editorTypeActionSchema,
  runtimeRunActionSchema,
  runtimeStartActionSchema,
  runtimeWaitForReadyActionSchema,
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
 * Lesson types are the six languages the platform teaches — not the starter
 * templates (react, vue, …), which are just seeded workspace conveniences.
 * javascript/typescript lessons pin arbitrary WebContainer (Node) workspaces;
 * python runs its WASI script model; go/kotlin/rust use their playgrounds.
 * Each value is also a valid `WorkspaceLessonType` for the pinned project.
 */
export const studioLessonTypeSchema = z.enum([
  "javascript",
  "typescript",
  "python",
  "go",
  "kotlin",
  "rust",
]);
export type StudioLessonType = z.infer<typeof studioLessonTypeSchema>;

/** Pinned workspace: full file contents, no external template resolution in M0. */
export const studioWorkspacePinSchema = z.object({
  lessonType: studioLessonTypeSchema,
  name: z.string().min(1),
  entryFilePath: z.string().min(1),
  files: z.record(z.string().min(1), z.string()),
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
 * Authored whiteboard asset: a small declarative spec the driver expands into
 * a full Excalidraw element (seeded, deterministic) at apply time.
 */
export const studioWhiteboardAssetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["rectangle", "ellipse", "text"]),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  text: z.string().optional(),
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
 * Execution-kind-specific runtime declaration. "live" calls the real
 * /api/<kind> proxy (requires a signed-in session); "fixture" replays the
 * pinned result. Unattended renders default to the plan's declared mode; the
 * manifest records which one ran. Kind "webcontainer" is the versioned JS/TS
 * lifecycle and preview contract. Kind "none" is reserved for lesson types
 * (currently Python) that narrate, edit, and use slides/whiteboard without a
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
    /** Exact contents are pinned in workspace.files and covered by the plan hash. */
    lockfilePath: z.string().min(1),
    environment: z.record(z.string().min(1), z.string()).default({}),
  }),
  z.object({
    kind: z.literal("go-playground"),
    defaultMode: z.enum(["live", "fixture"]),
    fixture: goRunFixtureSchema,
  }),
  z.object({
    kind: z.literal("kotlin-playground"),
    defaultMode: z.enum(["live", "fixture"]),
    fixture: kotlinRunFixtureSchema,
  }),
  z.object({
    kind: z.literal("rust-playground"),
    defaultMode: z.enum(["live", "fixture"]),
    fixture: rustRunFixtureSchema,
  }),
]);
export type StudioRuntime = z.infer<typeof studioRuntimeSchema>;
export type StudioRuntimeKind = StudioRuntime["kind"];
export type StudioRuntimeMode = "live" | "fixture";

/**
 * The one runtime kind each lesson type may declare. The three Playground
 * languages execute through their selective proxies; the WebContainer
 * JavaScript and TypeScript use the versioned WebContainer adapter; Python
 * remains edit-only until it has a Studio-owned runtime contract.
 */
export const RUNTIME_KIND_FOR_LESSON: Record<StudioLessonType, StudioRuntimeKind> = {
  javascript: "webcontainer",
  typescript: "webcontainer",
  python: "none",
  go: "go-playground",
  kotlin: "kotlin-playground",
  rust: "rust-playground",
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
      if (!(plan.runtime.lockfilePath in plan.workspace.files)) {
        ctx.addIssue({
          code: "custom",
          message: `WebContainer lockfile "${plan.runtime.lockfilePath}" is not in the pinned workspace`,
        });
      }
      for (const action of plan.actions) {
        if (action.type === "runtime.run" || action.type === "expect.output") {
          ctx.addIssue({
            code: "custom",
            message: `Action "${action.id}" (${action.type}) is a Playground command, not a WebContainer command`,
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

    // Typing must fit between its start and the next scheduled action: a run
    // scheduled before the edit can finish is an impossible overlap (§5).
    for (let i = 0; i < plan.actions.length; i++) {
      const action = plan.actions[i];
      if (action.type !== "editor.type") continue;
      const typingMs = action.chunks.reduce((total, chunk) => total + chunk.delayMs, 0);
      const next = plan.actions[i + 1];
      if (next && action.at + typingMs > next.at) {
        ctx.addIssue({
          code: "custom",
          message: `Typing action "${action.id}" (${typingMs}ms) overlaps "${next.id}" at ${next.at}ms`,
        });
      }
    }

    const lastAction = plan.actions[plan.actions.length - 1];
    if (lastAction.at >= plan.narration.expectedDurationMs) {
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
