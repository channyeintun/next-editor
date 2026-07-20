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

/** One pre-compiled typing burst: wait `delayMs` since the previous chunk, then insert `text`. */
export const typingChunkSchema = z.object({
  delayMs: nonNegativeMs,
  text: z.string().min(1),
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

const expectOutputActionSchema = planActionBase.extend({
  type: z.literal("expect.output"),
  contains: z.string().min(1),
});

const expectFileActionSchema = planActionBase.extend({
  type: z.literal("expect.file"),
  path: z.string().min(1),
  contains: z.string().min(1),
});

export const studioPlanActionSchema = z.discriminatedUnion("type", [
  openFileActionSchema,
  cursorMoveActionSchema,
  editorTypeActionSchema,
  runtimeRunActionSchema,
  expectOutputActionSchema,
  expectFileActionSchema,
]);
export type StudioPlanAction = z.infer<typeof studioPlanActionSchema>;
export type StudioPlanActionType = StudioPlanAction["type"];

/** Pinned workspace: full file contents, no external template resolution in M0. */
export const studioWorkspacePinSchema = z.object({
  lessonType: z.literal("go"),
  name: z.string().min(1),
  entryFilePath: z.string().min(1),
  files: z.record(z.string().min(1), z.string()),
});
export type StudioWorkspacePin = z.infer<typeof studioWorkspacePinSchema>;

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
  result: z.object({
    status: z.enum(["success", "compile-error", "vet-error", "runtime-error"]),
    output: z.string(),
    compileErrors: z.string().optional(),
    vetErrors: z.string().optional(),
    exitCode: z.number().int().optional(),
  }),
});

export const studioRuntimeSchema = z.object({
  kind: z.literal("go-playground"),
  /**
   * "live" calls the real /api/go-playground proxy (requires a signed-in
   * session); "fixture" replays the pinned result below. Unattended renders
   * default to the plan's declared mode; the manifest records which one ran.
   */
  defaultMode: z.enum(["live", "fixture"]),
  fixture: goRunFixtureSchema,
});
export type StudioRuntimeMode = z.infer<typeof studioRuntimeSchema>["defaultMode"];

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
    narration: studioNarrationSchema,
    runtime: studioRuntimeSchema,
    actions: z.array(studioPlanActionSchema).min(1),
  })
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    for (const action of plan.actions) {
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
