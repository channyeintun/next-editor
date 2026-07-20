import { z } from "zod";
import {
  goRunFixtureSchema,
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
  cadence: z.enum(["fast-explainer"]).default("fast-explainer"),
  text: z.string().min(1),
});

const scriptRuntimeRunSchema = scriptActionBase.extend({
  type: z.literal("runtime.run"),
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

export const scriptActionSchema = z.discriminatedUnion("type", [
  scriptOpenFileSchema,
  scriptEditorTypeSchema,
  scriptRuntimeRunSchema,
  scriptSlideShowSchema,
  scriptSlideCloseSchema,
  scriptWhiteboardApplySchema,
  scriptExpectOutputSchema,
  scriptExpectFileSchema,
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

export const lessonScriptSchema = z
  .object({
    schemaVersion: z.literal(LESSON_SCRIPT_SCHEMA_VERSION),
    lesson: z.object({
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      title: z.string().min(1),
      locale: z.string().min(1),
      workspace: studioWorkspacePinSchema,
      slides: z.array(studioSlideSchema).default([]),
      whiteboardAssets: z.array(studioWhiteboardAssetSchema).default([]),
    }),
    build: z.object({
      /** Registered voice profile id (provider + voice + settings). */
      voiceProfile: z.string().min(1),
      seed: z.number().int().nonnegative(),
    }),
    runtime: z.object({
      kind: z.literal("go-playground"),
      defaultMode: z.enum(["live", "fixture"]),
      fixture: goRunFixtureSchema,
    }),
    scenes: z.array(scriptSceneSchema).min(1),
    checks: z.array(scriptCheckSchema).default([]),
  })
  .superRefine((script, ctx) => {
    const actionIds = new Set<string>();
    for (const scene of script.scenes) {
      for (const action of scene.actions) {
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
