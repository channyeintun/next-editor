import { z } from "zod";
import {
  consoleLineTargetSchema as planConsoleLineTargetSchema,
  studioActionFieldShapes,
  studioActionTimeoutMsSchema,
  studioPreviewAttributeSchema as planPreviewAttributeSchema,
  studioPreviewTargetSchema as planPreviewTargetSchema,
  studioRetryPolicySchema as planRetryPolicySchema,
  studioRuntimeSchema as planRuntimeSchema,
  studioSlideSchema as planSlideSchema,
  studioWhiteboardAssetSchema as planWhiteboardAssetSchema,
  studioWorkspacePinSchema as planWorkspacePinSchema,
  withWhiteboardApplyRules,
} from "../plan";
import {
  actionContractIssues,
  pinnedReferenceIssues,
  runtimeContractIssues,
  type PinnedReference,
} from "../runtimeContract";
import { consolePointIssues } from "./consolePoints";
import {
  MarkerError,
  extractScriptNarration,
  requireMarker,
  type ExtractedNarration,
} from "./markers";

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
  timeoutMs: studioActionTimeoutMsSchema,
});

// The payloads the plan carries unchanged come from the plan's own shapes, with
// the strict nested schemas above passed in.
const fields = studioActionFieldShapes({
  retry: studioRetryPolicySchema,
  previewTarget: studioPreviewTargetSchema,
  attribute: planPreviewAttributeSchema.strict(),
});

const scriptOpenFileSchema = scriptActionBase.extend({
  type: z.literal("workspace.openFile"),
  ...fields["workspace.openFile"],
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
  ...fields["runtime.run"],
});

const scriptRuntimeStartSchema = scriptActionBase.extend({
  type: z.literal("runtime.start"),
  ...fields["runtime.start"],
});

const scriptRuntimeWaitForReadySchema = scriptActionBase.extend({
  type: z.literal("runtime.waitForReady"),
  ...fields["runtime.waitForReady"],
});

const scriptRuntimeCollapseDockSchema = scriptActionBase.extend({
  type: z.literal("runtime.collapseDock"),
  ...fields["runtime.collapseDock"],
});

const scriptPreviewOpenSchema = scriptActionBase.extend({
  type: z.literal("preview.open"),
  ...fields["preview.open"],
});

const scriptPreviewClickSchema = scriptActionBase.extend({
  type: z.literal("preview.click"),
  ...fields["preview.click"],
});

const scriptPreviewInputSchema = scriptActionBase.extend({
  type: z.literal("preview.input"),
  ...fields["preview.input"],
});

const scriptPreviewScrollSchema = scriptActionBase.extend({
  type: z.literal("preview.scroll"),
  ...fields["preview.scroll"],
});

const scriptPreviewRouteSchema = scriptActionBase.extend({
  type: z.literal("preview.route"),
  ...fields["preview.route"],
});

const scriptSlideShowSchema = scriptActionBase.extend({
  type: z.literal("slide.show"),
  ...fields["slide.show"],
});

const scriptSlideCloseSchema = scriptActionBase.extend({
  type: z.literal("slide.close"),
  ...fields["slide.close"],
});

const scriptWhiteboardApplySchema = withWhiteboardApplyRules(
  scriptActionBase.extend({
    type: z.literal("whiteboard.apply"),
    ...fields["whiteboard.apply"],
  }),
);

const scriptExpectOutputSchema = scriptActionBase.extend({
  type: z.literal("expect.output"),
  ...fields["expect.output"],
});

const scriptExpectFileSchema = scriptActionBase.extend({
  type: z.literal("expect.file"),
  ...fields["expect.file"],
});

const scriptExpectPreviewSchema = scriptActionBase.extend({
  type: z.literal("expect.preview"),
  ...fields["expect.preview"],
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

/** The pinned files, slides and whiteboard assets a script action names. */
function scriptPinnedReferences(action: ScriptAction): PinnedReference[] {
  switch (action.type) {
    case "workspace.openFile":
      return [{ id: action.id, kind: "file", value: action.path, verb: "opens" }];
    case "editor.type":
      return [{ id: action.id, kind: "file", value: action.target.file, verb: "types into" }];
    case "editor.select":
      return [{ id: action.id, kind: "file", value: action.target.file, verb: "selects in" }];
    case "expect.file":
      return [{ id: action.id, kind: "file", value: action.path, verb: "checks" }];
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

    const pins = {
      files: script.lesson.workspace.files,
      slides: script.lesson.slides,
      whiteboardAssets: script.lesson.whiteboardAssets,
    };
    for (const scene of script.scenes) {
      for (const action of scene.actions) {
        if ("afterAction" in action.at && !actionIds.has(action.at.afterAction)) {
          ctx.addIssue({
            code: "custom",
            message: `Action "${action.id}" anchors after unknown action "${action.at.afterAction}"`,
          });
        }
        for (const message of pinnedReferenceIssues(pins, scriptPinnedReferences(action))) {
          ctx.addIssue({ code: "custom", message });
        }
      }
    }

    // Everything below is decidable from the script text alone, so it fails
    // here — at Import, picker load, the Director CLI and render start — rather
    // than in the compiler after every dialog has been synthesized.
    let extracted: ExtractedNarration | null = null;
    try {
      extracted = extractScriptNarration(script);
    } catch (error) {
      if (!(error instanceof MarkerError)) throw error;
      ctx.addIssue({ code: "custom", message: error.message });
    }
    if (extracted) {
      script.scenes.forEach((scene, sceneIndex) => {
        scene.actions.forEach((action, actionIndex) => {
          if (!("mark" in action.at)) return;
          try {
            requireMarker(extracted, action.at.mark);
          } catch (error) {
            if (!(error instanceof MarkerError)) throw error;
            ctx.addIssue({
              code: "custom",
              message: error.message,
              path: ["scenes", sceneIndex, "actions", actionIndex, "at", "mark"],
            });
          }
        });
      });
    }

    // afterAction chains must bottom out at a mark or scene anchor. An unknown
    // predecessor is reported above, so it counts as resolved here; whatever
    // stays unresolved sits on (or hangs off) a cycle — the compiler's message.
    const resolved = new Set(
      actions
        .filter((action) => !("afterAction" in action.at) || !actionIds.has(action.at.afterAction))
        .map((action) => action.id),
    );
    let pending = actions.filter((action) => !resolved.has(action.id));
    let progressed = true;
    while (pending.length > 0 && progressed) {
      const stillPending = pending.filter(
        (action) => "afterAction" in action.at && !resolved.has(action.at.afterAction),
      );
      progressed = stillPending.length < pending.length;
      for (const action of pending) {
        if (!stillPending.includes(action)) resolved.add(action.id);
      }
      pending = stillPending;
    }
    if (pending.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `Unresolvable afterAction chain (cycle?): ${pending.map((action) => action.id).join(", ")}`,
      });
    }

    for (const message of consolePointIssues(script)) {
      ctx.addIssue({ code: "custom", message });
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
