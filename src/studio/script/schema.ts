import { z } from "zod";
import {
  WHITEBOARD_DRAW_MAX_MS,
  consoleLineTargetSchema as planConsoleLineTargetSchema,
  studioPreviewTargetSchema as planPreviewTargetSchema,
  studioRetryPolicySchema as planRetryPolicySchema,
  studioRuntimeSchema as planRuntimeSchema,
  studioSlideSchema as planSlideSchema,
  studioWhiteboardAssetSchema as planWhiteboardAssetSchema,
  studioWorkspacePinSchema as planWorkspacePinSchema,
} from "../plan";
import { actionContractIssues, runtimeContractIssues } from "../runtimeContract";

/**
 * `LessonScript` — the authored, reviewable source of a lesson
 * (docs/agent-lesson-production.md §5). YAML is the authoring surface; this
 * schema is the contract. Scripts anchor actions to narration markers
 * (`[[mark:name]]` tokens inside scene narration), never to wall-clock times —
 * the Director resolves markers against the synthesized narration's alignment
 * and compiles everything into an absolute-time `StudioPlan`.
 */

export const LESSON_SCRIPT_SCHEMA_VERSION = 1;

/**
 * The Worker's TTS route and the Modal synthesizer both reject seeds above a
 * signed 32-bit int, so a larger one would pass here and fail only at render.
 */
export const LESSON_SCRIPT_MAX_SEED = 0x7fffffff;

/*
 * Every object a script author writes is strict: zod's default mode strips
 * unknown keys, so a typo such as `cadance: block` or `offsetMS: 400` used to
 * parse cleanly and render with the default instead. The plan schemas the
 * script reuses are tightened the same way here, without changing the plan.
 */
const studioRetryPolicySchema = planRetryPolicySchema.strict();
const studioPreviewTargetSchema = planPreviewTargetSchema.strict();
const studioWorkspacePinSchema = planWorkspacePinSchema.strict();
const studioSlideSchema = planSlideSchema.strict();
const studioWhiteboardAssetSchema = planWhiteboardAssetSchema.strict();
// The cast only keeps LessonScript["runtime"] assignable to the plan's runtime
// type; .strict() changes no field, so the options' shapes stay identical.
const studioRuntimeSchema = z.discriminatedUnion(
  "kind",
  planRuntimeSchema.options.map((option) => option.strict()) as unknown as [
    ...typeof planRuntimeSchema.options,
  ],
);

const offsetMs = z.number().finite().min(-30_000).max(30_000);

const ANCHOR_KINDS = ["scene", "mark", "afterAction"];
const ANCHOR_KEYS = [...ANCHOR_KINDS, "offsetMs"];

/**
 * A plain union reports only "Invalid input" when every branch fails, which
 * hides the cause — most often a misspelled key, or `mark` and `afterAction`
 * written together on one anchor.
 */
function anchorErrorMessage(input: unknown): string {
  const shape =
    "an anchor is { scene: start }, { mark: <name> } or { afterAction: <id> }, and only the first two take offsetMs";
  const keys = typeof input === "object" && input !== null ? Object.keys(input) : [];
  const unknownKeys = keys.filter((key) => !ANCHOR_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    return `Unrecognized anchor key${unknownKeys.length > 1 ? "s" : ""} ${unknownKeys
      .map((key) => `"${key}"`)
      .join(", ")}; ${shape}`;
  }
  const kinds = keys.filter((key) => ANCHOR_KINDS.includes(key));
  if (kinds.length > 1) {
    return `An anchor names exactly one of scene, mark or afterAction, got ${kinds.join(" and ")}; ${shape}`;
  }
  return `Invalid anchor; ${shape}`;
}

/** Narration-relative anchor. Absolute times are forbidden in source scripts. */
export const scriptAnchorSchema = z.union(
  [
    z.strictObject({ scene: z.literal("start"), offsetMs: offsetMs.default(0) }),
    z.strictObject({ mark: z.string().min(1), offsetMs: offsetMs.default(0) }),
    /**
     * After the referenced action completes. The Performer is strictly
     * sequential. The compiler advances past deterministic typing/selection busy
     * time; runtime/preview waits use the predecessor's planned start as a
     * placeholder, while the receipt records the actual acknowledgement-relative
     * start.
     */
    z.strictObject({ afterAction: z.string().min(1) }),
  ],
  { error: (issue) => anchorErrorMessage(issue.input) },
);
export type ScriptAnchor = z.infer<typeof scriptAnchorSchema>;

/**
 * Text targets name file + anchor + occurrence. `occurrence` defaults to 1 and
 * the first exact match of `after` wins, so an anchor that occurs more than
 * once is not an error — add context to `after` or set `occurrence` to pick a
 * later match.
 */
export const scriptTextTargetSchema = z.strictObject({
  file: z.string().min(1),
  after: z.string(),
  occurrence: z.number().int().min(1).default(1),
});

/**
 * Selection targets name the exact code to highlight: the `occurrence`-th
 * byte-for-byte match of `text` in the file's current content becomes the
 * selected range (same exact-substring rule as `editor.type`'s `after`).
 */
export const scriptSelectTargetSchema = z.strictObject({
  file: z.string().min(1),
  text: z.string().min(1),
  occurrence: z.number().int().min(1).default(1),
});

const scriptActionBase = z.strictObject({
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

// Points at a line of the program's output while the narration reads it: the
// latest run's `occurrence`-th console line containing `text`.
const scriptConsolePointSchema = scriptActionBase.extend({
  type: z.literal("console.point"),
  target: planConsoleLineTargetSchema.strict(),
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
  // Mirrors the plan schema's rule, so an apply that does nothing fails when the
  // script is parsed instead of at compile time, after narration is synthesized.
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
  attribute: z.strictObject({ name: z.string().min(1), value: z.string() }).optional(),
  retry: studioRetryPolicySchema,
});

export const scriptActionSchema = z.discriminatedUnion("type", [
  scriptOpenFileSchema,
  scriptEditorTypeSchema,
  scriptEditorSelectSchema,
  scriptConsolePointSchema,
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
export const scriptSourceSchema = z.strictObject({
  title: z.string().min(1),
  url: z.string().url(),
});

export const scriptSceneSchema = z.strictObject({
  id: z.string().min(1),
  /**
   * Titles the chapter this scene starts. The rendered lesson lists its chapters and marks
   * them on the progress bar; a scene without one continues the chapter before it.
   */
  chapter: z.string().trim().min(1).max(120).optional(),
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
  z.strictObject({
    type: z.literal("timing.p95Ms"),
    max: z.number().finite().positive(),
  }),
]);

/**
 * A slide sourced from one page of a published Google Slides deck
 * (File → Share → Publish to web). The Director fetches the deck once at
 * compile time and pins the page's normalized SVG into the plan.
 */
export const googleSlideRefSchema = z.strictObject({
  id: z.string().min(1),
  contentType: z.literal("google"),
  deckUrl: z.string().url(),
  pageId: z.string().min(1),
  name: z.string().optional(),
});
export type GoogleSlideRef = z.infer<typeof googleSlideRefSchema>;

export const scriptSlideSchema = z.discriminatedUnion("contentType", [
  studioSlideSchema,
  googleSlideRefSchema,
]);
export type ScriptSlide = z.infer<typeof scriptSlideSchema>;

export const lessonScriptSchema = z
  .strictObject({
    schemaVersion: z.literal(LESSON_SCRIPT_SCHEMA_VERSION),
    lesson: z.strictObject({
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      title: z.string().min(1),
      locale: z.string().min(1),
      workspace: studioWorkspacePinSchema,
      slides: z.array(scriptSlideSchema).default([]),
      whiteboardAssets: z.array(studioWhiteboardAssetSchema).default([]),
    }),
    build: z.strictObject({
      /** Registered voice profile id (provider + voice + settings). */
      voiceProfile: z.string().min(1),
      seed: z
        .number()
        .int()
        .nonnegative()
        .max(LESSON_SCRIPT_MAX_SEED, {
          message: `must be at most ${LESSON_SCRIPT_MAX_SEED} — the narration synthesizers take a signed 32-bit seed`,
        }),
    }),
    runtime: studioRuntimeSchema,
    scenes: z.array(scriptSceneSchema).min(1),
    checks: z.array(scriptCheckSchema).default([]),
  })
  .superRefine((script, ctx) => {
    const actions = script.scenes.flatMap((scene) => scene.actions);
    for (const message of runtimeContractIssues(script.lesson.workspace, script.runtime, actions)) {
      ctx.addIssue({ code: "custom", message });
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

    for (const message of actionContractIssues(actions)) {
      ctx.addIssue({ code: "custom", message });
    }
    const actionIds = new Set(actions.map((action) => action.id));

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
