import { z } from "zod";
import {
  RUNTIME_KIND_FOR_LESSON,
  WHITEBOARD_DRAW_MAX_MS,
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
   * sequential. The compiler advances past deterministic typing/selection busy
   * time; runtime/preview waits use the predecessor's planned start as a
   * placeholder, while the receipt records the actual acknowledgement-relative
   * start.
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

/**
 * Selection targets name the exact code to highlight: the `occurrence`-th
 * byte-for-byte match of `text` in the file's current content becomes the
 * selected range (same exact-substring rule as `editor.type`'s `after`).
 */
export const scriptSelectTargetSchema = z.object({
  file: z.string().min(1),
  text: z.string().min(1),
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

const scriptEditorSelectSchema = scriptActionBase.extend({
  type: z.literal("editor.select"),
  target: scriptSelectTargetSchema,
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

// `runtime.run` opens the runner dock and nothing closes it again, so it sits
// over the editor through the explanation that follows. This hands that back to
// the author: collapse it once the output has been read — or before a single
// line has been typed, so the dock costs a tab strip instead of 288px until
// there is finally something in it.
const scriptRuntimeCollapseDockSchema = scriptActionBase.extend({
  type: z.literal("runtime.collapseDock"),
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

const scriptWhiteboardApplySchema = scriptActionBase
  .extend({
    type: z.literal("whiteboard.apply"),
    open: z.boolean().optional(),
    maximized: z.boolean().optional(),
    upsertIds: z.array(z.string().min(1)).default([]),
    /**
     * Wipe the board before drawing: an apply otherwise only adds, so a second
     * diagram sharing the first one's coordinates would land on top of it.
     */
    clear: z.boolean().default(false),
    /**
     * Draw the upserts in over this budget instead of applying them in one
     * frame. Shapes grow from their corner, text types, freedraw strokes
     * trace, and several assets are drawn one after another. `0` (default)
     * keeps the instant apply.
     */
    drawMs: z.number().finite().nonnegative().max(WHITEBOARD_DRAW_MAX_MS).default(0),
  })
  .refine((action) => action.drawMs < action.timeoutMs, {
    message: "whiteboard.apply drawMs must be shorter than the action's timeoutMs",
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
  attribute: z.object({ name: z.string().min(1), value: z.string() }).optional(),
  retry: studioRetryPolicySchema,
});

export const scriptActionSchema = z.discriminatedUnion("type", [
  scriptOpenFileSchema,
  scriptEditorTypeSchema,
  scriptEditorSelectSchema,
  scriptRuntimeRunSchema,
  scriptRuntimeStartSchema,
  scriptRuntimeWaitForReadySchema,
  scriptRuntimeCollapseDockSchema,
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

/**
 * Per-script QA thresholds. Only checks that a script can actually configure
 * belong here: artifact gates like `recording.decodes` and `runtime.noErrors`
 * run on every render regardless, so declaring them was decorative — the value
 * never reached the plan, and omitting them switched nothing off.
 */
export const scriptCheckSchema = z.discriminatedUnion("type", [
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
            // A lesson with no runtime never renders a runner dock to collapse.
            action.type === "runtime.collapseDock" ||
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
      // Python runs one-shot on the WebContainer's WASI `python3`: no package
      // install (so no lockfile), no dev server, no preview. JS/TS drive a dev
      // server + preview and must pin a lockfile for a reproducible install.
      const isPython = script.lesson.workspace.lessonType === "python";
      if (script.runtime.lockfilePath === undefined) {
        if (!isPython) {
          ctx.addIssue({
            code: "custom",
            message: `A ${script.lesson.workspace.lessonType} WebContainer lesson must pin a lockfilePath for a reproducible install`,
          });
        }
      } else if (!(script.runtime.lockfilePath in script.lesson.workspace.files)) {
        ctx.addIssue({
          code: "custom",
          message: `WebContainer lockfile "${script.runtime.lockfilePath}" is not in the pinned workspace`,
        });
      }
      if (isPython) {
        if (script.runtime.lockfilePath !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: "A Python WebContainer lesson must omit lockfilePath (nothing is installed)",
          });
        }
        if (script.runtime.expectedPort !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: "A Python WebContainer lesson must omit expectedPort (it has no server)",
          });
        }
        if (script.runtime.initCommand.trim() !== "") {
          ctx.addIssue({
            code: "custom",
            message: "A Python WebContainer lesson must use an empty initCommand",
          });
        }
        if (!/^python3(?:\s|$)/.test(script.runtime.runCommand.trim())) {
          ctx.addIssue({
            code: "custom",
            message: 'A Python WebContainer lesson runCommand must invoke "python3"',
          });
        }
      }
      for (const scene of script.scenes) {
        for (const action of scene.actions) {
          if (action.type === "runtime.run") {
            ctx.addIssue({
              code: "custom",
              message: `Action "${action.id}" (runtime.run) is a Playground command; a WebContainer lesson runs via runtime.start`,
            });
          }
          if (isPython) {
            // WASI Python cannot bind a socket — no server to wait for, no preview
            // to drive; it asserts through console expect.output.
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
              message: `Action "${action.id}" (expect.output) is for console runtimes; a ${script.lesson.workspace.lessonType} preview lesson asserts with expect.preview`,
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

    // The timing gate is the one QA threshold a script owns, and it only exists
    // when declared — an omitted `checks` block used to mean "render with no
    // timing gate at all", silently, while every skill and doc says to include it.
    if (!script.checks.some((check) => check.type === "timing.p95Ms")) {
      ctx.addIssue({
        code: "custom",
        message:
          "Every lesson must declare a timing gate: checks: [{ type: timing.p95Ms, max: 300 }] (use max: 500 when the lesson shows Google-deck slides)",
      });
    }

    // Caught here rather than at compile time: `scenes[].actions` defaults to []
    // so a narration-only script parses, and the compiled plan would then fail the
    // plan schema's non-empty `actions` rule with no hint of what to add.
    if (script.scenes.every((scene) => scene.actions.length === 0)) {
      ctx.addIssue({
        code: "custom",
        message:
          "This lesson has no actions — narration alone never touches the editor. Add at least one action (workspace.openFile, editor.type, …) to a scene",
      });
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
        if (action.type === "editor.select" && !(action.target.file in workspaceFiles)) {
          ctx.addIssue({
            code: "custom",
            message: `Action "${action.id}" selects in "${action.target.file}" which is not in the pinned workspace`,
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
