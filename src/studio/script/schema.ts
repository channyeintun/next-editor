import { z } from "zod";
import {
  RUNTIME_KIND_FOR_LESSON,
  studioPreviewTargetSchema,
  studioRetryPolicySchema,
  studioRuntimeSchema,
  studioSlideSchema,
  studioWhiteboardAssetSchema,
  studioWorkspacePinSchema,
} from "../plan";

/**
 * `LessonScript` — the authored, reviewable source of a lesson
 * (docs/agent-lesson-production.md §5). YAML is the authoring surface; this
 * schema is the contract. Scripts anchor actions to narration markers
 * (`[[mark:name]]` tokens inside scene narration), never to wall-clock times —
 * the Director resolves markers against the synthesized narration's alignment
 * and compiles everything into an absolute-time `StudioPlan`.
 */

export const LESSON_SCRIPT_SCHEMA_VERSION = 1;

const offsetMs = z.number().finite().min(-30_000).max(30_000);

/** Narration-relative anchor. Absolute times are forbidden in source scripts. */
export const scriptAnchorSchema = z.union([
  z.object({ scene: z.literal("start"), offsetMs: offsetMs.default(0) }),
  z.object({ mark: z.string().min(1), offsetMs: offsetMs.default(0) }),
  /**
   * After the referenced action completes. The Performer is strictly
   * sequential, so the compiled `at` equals the referenced action's `at`; the
   * receipt records the actual (later) start.
   */
  z.object({ afterAction: z.string().min(1) }),
]);
export type ScriptAnchor = z.infer<typeof scriptAnchorSchema>;

/** Text targets require file + anchor + occurrence; compilation fails on ambiguity. */
export const scriptTextTargetSchema = z.object({
  file: z.string().min(1),
  after: z.string(),
  occurrence: z.number().int().min(1).default(1),
});

const scriptActionBase = z.object({
  id: z.string().min(1),
  at: scriptAnchorSchema,
  timeoutMs: z.number().finite().positive().default(10_000),
});

const scriptOpenFileSchema = scriptActionBase.extend({
  type: z.literal("workspace.openFile"),
  path: z.string().min(1),
});

const scriptEditorTypeSchema = scriptActionBase.extend({
  type: z.literal("editor.type"),
  target: scriptTextTargetSchema,
  /**
   * How the insertion appears: simulated keystrokes ("natural" default,
   * "fast-explainer" brisker), an incremental per-line reveal with no
   * keystrokes ("line-by-line"), or the whole block at once ("block").
   */
  cadence: z.enum(["natural", "fast-explainer", "line-by-line", "block"]).default("natural"),
  text: z.string().min(1),
});

const scriptRuntimeRunSchema = scriptActionBase.extend({
  type: z.literal("runtime.run"),
});

const scriptRuntimeStartSchema = scriptActionBase.extend({
  type: z.literal("runtime.start"),
  retry: studioRetryPolicySchema,
});

const scriptRuntimeWaitForReadySchema = scriptActionBase.extend({
  type: z.literal("runtime.waitForReady"),
  retry: studioRetryPolicySchema,
});

const scriptPreviewOpenSchema = scriptActionBase.extend({
  type: z.literal("preview.open"),
  mode: z.enum(["docked", "floating"]).default("docked"),
  retry: studioRetryPolicySchema,
});

const scriptPreviewClickSchema = scriptActionBase.extend({
  type: z.literal("preview.click"),
  target: studioPreviewTargetSchema,
  retry: studioRetryPolicySchema,
});

const scriptPreviewInputSchema = scriptActionBase.extend({
  type: z.literal("preview.input"),
  target: studioPreviewTargetSchema,
  value: z.string(),
  retry: studioRetryPolicySchema,
});

const scriptPreviewScrollSchema = scriptActionBase.extend({
  type: z.literal("preview.scroll"),
  target: studioPreviewTargetSchema.optional(),
  top: z.number().finite(),
  left: z.number().finite().default(0),
  retry: studioRetryPolicySchema,
});

const scriptPreviewRouteSchema = scriptActionBase.extend({
  type: z.literal("preview.route"),
  route: z.string().startsWith("/").min(1),
  retry: studioRetryPolicySchema,
});

const scriptSlideShowSchema = scriptActionBase.extend({
  type: z.literal("slide.show"),
  slideId: z.string().min(1),
  maximized: z.boolean().default(true),
});

const scriptSlideCloseSchema = scriptActionBase.extend({
  type: z.literal("slide.close"),
});

const scriptWhiteboardApplySchema = scriptActionBase.extend({
  type: z.literal("whiteboard.apply"),
  open: z.boolean().optional(),
  maximized: z.boolean().optional(),
  upsertIds: z.array(z.string().min(1)).default([]),
});

const scriptExpectOutputSchema = scriptActionBase.extend({
  type: z.literal("expect.output"),
  contains: z.string().min(1),
});

const scriptExpectFileSchema = scriptActionBase.extend({
  type: z.literal("expect.file"),
  path: z.string().min(1),
  contains: z.string().min(1),
});

const scriptExpectPreviewSchema = scriptActionBase.extend({
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

export const scriptActionSchema = z.discriminatedUnion("type", [
  scriptOpenFileSchema,
  scriptEditorTypeSchema,
  scriptRuntimeRunSchema,
  scriptRuntimeStartSchema,
  scriptRuntimeWaitForReadySchema,
  scriptPreviewOpenSchema,
  scriptPreviewClickSchema,
  scriptPreviewInputSchema,
  scriptPreviewScrollSchema,
  scriptPreviewRouteSchema,
  scriptSlideShowSchema,
  scriptSlideCloseSchema,
  scriptWhiteboardApplySchema,
  scriptExpectOutputSchema,
  scriptExpectFileSchema,
  scriptExpectPreviewSchema,
]);
export type ScriptAction = z.infer<typeof scriptActionSchema>;

/** A cited source backing the scene's claims (required by the editorial gate). */
export const scriptSourceSchema = z.object({
  title: z.string().min(1),
  url: z.string().url(),
});

export const scriptSceneSchema = z.object({
  id: z.string().min(1),
  /** Display narration with `[[mark:name]]` control tokens. */
  narration: z.string().min(1),
  sources: z.array(scriptSourceSchema).default([]),
  actions: z.array(scriptActionSchema).default([]),
});
export type ScriptScene = z.infer<typeof scriptSceneSchema>;

export const scriptCheckSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("recording.decodes") }),
  z.object({ type: z.literal("runtime.noErrors") }),
  z.object({
    type: z.literal("timing.p95Ms"),
    max: z.number().finite().positive(),
  }),
]);

/**
 * A slide sourced from one page of a published Google Slides deck
 * (File → Share → Publish to web). The Director fetches the deck once at
 * compile time and pins the page's normalized SVG into the plan.
 */
export const googleSlideRefSchema = z.object({
  id: z.string().min(1),
  contentType: z.literal("google"),
  deckUrl: z.string().url(),
  pageId: z.string().min(1),
  name: z.string().optional(),
});
export type GoogleSlideRef = z.infer<typeof googleSlideRefSchema>;

export const scriptSlideSchema = z.union([studioSlideSchema, googleSlideRefSchema]);
export type ScriptSlide = z.infer<typeof scriptSlideSchema>;

export const lessonScriptSchema = z
  .object({
    schemaVersion: z.literal(LESSON_SCRIPT_SCHEMA_VERSION),
    lesson: z.object({
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      title: z.string().min(1),
      locale: z.string().min(1),
      workspace: studioWorkspacePinSchema,
      slides: z.array(scriptSlideSchema).default([]),
      whiteboardAssets: z.array(studioWhiteboardAssetSchema).default([]),
    }),
    build: z.object({
      /** Registered voice profile id (provider + voice + settings). */
      voiceProfile: z.string().min(1),
      seed: z.number().int().nonnegative(),
    }),
    runtime: studioRuntimeSchema,
    scenes: z.array(scriptSceneSchema).min(1),
    checks: z.array(scriptCheckSchema).default([]),
  })
  .superRefine((script, ctx) => {
    const expectedKind = RUNTIME_KIND_FOR_LESSON[script.lesson.workspace.lessonType];
    if (script.runtime.kind !== expectedKind) {
      ctx.addIssue({
        code: "custom",
        message: `Lesson type "${script.lesson.workspace.lessonType}" requires runtime kind "${expectedKind}", got "${script.runtime.kind}"`,
      });
    }
    if (script.runtime.kind === "none") {
      for (const scene of script.scenes) {
        for (const action of scene.actions) {
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
              message: `Action "${action.id}" (${action.type}) needs a runnable runtime, but lesson type "${script.lesson.workspace.lessonType}" has none in the studio yet`,
            });
          }
        }
      }
    }
    if (script.runtime.kind === "webcontainer") {
      if (!(script.runtime.lockfilePath in script.lesson.workspace.files)) {
        ctx.addIssue({
          code: "custom",
          message: `WebContainer lockfile "${script.runtime.lockfilePath}" is not in the pinned workspace`,
        });
      }
      for (const scene of script.scenes) {
        for (const action of scene.actions) {
          if (action.type === "runtime.run" || action.type === "expect.output") {
            ctx.addIssue({
              code: "custom",
              message: `Action "${action.id}" (${action.type}) is a Playground command, not a WebContainer command`,
            });
          }
        }
      }
    } else if (script.runtime.kind !== "none") {
      for (const scene of script.scenes) {
        for (const action of scene.actions) {
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
    }

    const actionIds = new Set<string>();
    for (const scene of script.scenes) {
      for (const action of scene.actions) {
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
        if (actionIds.has(action.id)) {
          ctx.addIssue({ code: "custom", message: `Duplicate action id "${action.id}"` });
        }
        actionIds.add(action.id);
      }
    }

    const sceneIds = new Set<string>();
    for (const scene of script.scenes) {
      if (sceneIds.has(scene.id)) {
        ctx.addIssue({ code: "custom", message: `Duplicate scene id "${scene.id}"` });
      }
      sceneIds.add(scene.id);
    }

    for (const scene of script.scenes) {
      for (const action of scene.actions) {
        if ("afterAction" in action.at && !actionIds.has(action.at.afterAction)) {
          ctx.addIssue({
            code: "custom",
            message: `Action "${action.id}" anchors after unknown action "${action.at.afterAction}"`,
          });
        }
        const workspaceFiles = script.lesson.workspace.files;
        if (action.type === "workspace.openFile" && !(action.path in workspaceFiles)) {
          ctx.addIssue({
            code: "custom",
            message: `Action "${action.id}" opens "${action.path}" which is not in the pinned workspace`,
          });
        }
        if (action.type === "editor.type" && !(action.target.file in workspaceFiles)) {
          ctx.addIssue({
            code: "custom",
            message: `Action "${action.id}" types into "${action.target.file}" which is not in the pinned workspace`,
          });
        }
        if (action.type === "expect.file" && !(action.path in workspaceFiles)) {
          ctx.addIssue({
            code: "custom",
            message: `Action "${action.id}" checks "${action.path}" which is not in the pinned workspace`,
          });
        }
        if (action.type === "slide.show") {
          if (!script.lesson.slides.some((slide) => slide.id === action.slideId)) {
            ctx.addIssue({
              code: "custom",
              message: `Action "${action.id}" shows slide "${action.slideId}" which is not a pinned slide asset`,
            });
          }
        }
        if (action.type === "whiteboard.apply") {
          for (const assetId of action.upsertIds) {
            if (!script.lesson.whiteboardAssets.some((asset) => asset.id === assetId)) {
              ctx.addIssue({
                code: "custom",
                message: `Action "${action.id}" upserts whiteboard asset "${assetId}" which is not pinned`,
              });
            }
          }
        }
      }
    }
  });

export type LessonScript = z.infer<typeof lessonScriptSchema>;

export function parseLessonScript(candidate: unknown): LessonScript {
  const result = lessonScriptSchema.safeParse(candidate);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(script)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid lesson script: ${details}`);
  }
  return result.data;
}
