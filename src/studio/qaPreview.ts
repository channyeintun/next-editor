import type { Recording } from "../core/src";
import type { RuntimeRecordingSnapshot } from "../core/src/runtime";
import type { StudioPlan, StudioPlanAction } from "./plan";
import { previewExpectationMismatches } from "./previewExpectation";
import type { StudioCheckResult } from "./report";

/**
 * The preview gates of the artifact QA (qa.ts): the preview records, replay
 * data and round trip a preview plan needs, the authored preview commands in
 * order, each expect.preview checkpoint, and no preview errors.
 */

/**
 * A console line the preview wrote to report a failure — `[preview:error] …`,
 * the shape formatPreviewConsoleLine writes. preview.noErrors and
 * runtime.noErrors both match it here, with one (case-insensitive) rule.
 */
export const PREVIEW_ERROR_LINE = /^\[preview:error\]/i;

/** Captures the preview, lazily, when an artifact-level preview checkpoint fails. */
export type PreviewScreenshotCapture = () => Promise<{
  dataUrl: string;
  height: number;
  width: number;
}>;

type RecordedPreviewEvent = NonNullable<Recording["previewEvents"]>[number];
type PreviewCommandAction = Extract<
  StudioPlanAction,
  {
    type: "preview.open" | "preview.click" | "preview.input" | "preview.scroll" | "preview.route";
  }
>;
type PreviewExpectationAction = Extract<StudioPlanAction, { type: "expect.preview" }>;

export function planUsesPreview(plan: StudioPlan): boolean {
  return plan.actions.some(
    (action) => action.type.startsWith("preview.") || action.type === "expect.preview",
  );
}

function isPreviewCommandAction(action: StudioPlanAction): action is PreviewCommandAction {
  return (
    action.type === "preview.open" ||
    action.type === "preview.click" ||
    action.type === "preview.input" ||
    action.type === "preview.scroll" ||
    action.type === "preview.route"
  );
}

function previewEventMatchesAction(
  event: RecordedPreviewEvent,
  action: PreviewCommandAction,
): boolean {
  if (event.timestamp + 1_000 < action.at) {
    return false;
  }
  switch (action.type) {
    case "preview.open":
      return event.type === "preview_open" && event.isOpen === true && event.mode === action.mode;
    case "preview.click":
      return (
        event.type === "preview_interaction" &&
        event.interaction?.type === "click" &&
        event.interaction.target.testId === action.target.value
      );
    case "preview.input":
      return (
        event.type === "preview_interaction" &&
        event.interaction?.type === "input" &&
        event.interaction.target.testId === action.target.value &&
        event.interaction.data?.value === action.value
      );
    case "preview.scroll":
      return action.target
        ? event.type === "preview_interaction" &&
            event.interaction?.type === "scroll" &&
            event.interaction.target.testId === action.target.value &&
            event.interaction.data?.scrollTop === action.top &&
            event.interaction.data?.scrollLeft === action.left
        : event.type === "preview_scroll" &&
            event.scrollTop === action.top &&
            event.scrollLeft === action.left;
    case "preview.route":
      return event.type === "preview_route_change" && event.route === action.route;
  }
}

function previewCheckpointFailure(
  action: PreviewExpectationAction,
  event: RecordedPreviewEvent | undefined,
): string | null {
  const checkpoint = event?.checkpoint;
  if (event?.type !== "preview_checkpoint" || !checkpoint) {
    return "recorded checkpoint missing";
  }
  // The same comparison the driver ran live, plus the element check the live
  // inspection never needs; the first mismatch is the detail.
  const [mismatch] = previewExpectationMismatches(
    {
      route: action.route,
      testId: action.target?.value,
      textContains: action.textContains,
      value: action.value,
      attribute: action.attribute,
    },
    checkpoint,
  );
  return mismatch ?? null;
}

export interface PreviewGateInput {
  /** The in-memory recording, compared with the decoded one by preview.roundTrip. */
  recording: Recording;
  /** The decoded artifact, or null when it did not decode. */
  decoded: Recording | null;
  artifactRecording: Recording;
  plan: StudioPlan;
  lastRuntimeSnapshot: RuntimeRecordingSnapshot | null;
  consoleLines: readonly string[];
  capturePreviewScreenshot?: PreviewScreenshotCapture;
}

export async function previewGateChecks({
  recording,
  decoded,
  artifactRecording,
  plan,
  lastRuntimeSnapshot,
  consoleLines,
  capturePreviewScreenshot,
}: PreviewGateInput): Promise<StudioCheckResult[]> {
  const results: StudioCheckResult[] = [];
  const usesPreview = planUsesPreview(plan);
  let previewDiagnosticPromise: Promise<NonNullable<StudioCheckResult["diagnostic"]>> | undefined;
  const previewDiagnostic = () => {
    if (!previewDiagnosticPromise) {
      previewDiagnosticPromise = (async () => {
        if (!capturePreviewScreenshot) {
          return { previewScreenshot: { error: "preview screenshot capture is unavailable" } };
        }
        try {
          return { previewScreenshot: await capturePreviewScreenshot() };
        } catch (error) {
          return {
            previewScreenshot: {
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      })();
    }
    return previewDiagnosticPromise;
  };

  // Preview records are required only when the compiled plan declares preview use.
  const previewEvents = artifactRecording.previewEvents ?? [];
  const previewDocuments = artifactRecording.previewInitialDocuments ?? [];
  const previewPatches = artifactRecording.previewPatchBatches ?? [];
  const interactionActions = plan.actions.filter(isPreviewCommandAction);
  const needsPatchData = interactionActions.some(
    (action) =>
      action.type === "preview.click" ||
      action.type === "preview.input" ||
      action.type === "preview.scroll" ||
      action.type === "preview.route",
  );
  const recordsPresent =
    !usesPreview ||
    (previewEvents.length > 0 &&
      previewDocuments.length > 0 &&
      (!needsPatchData || previewPatches.length > 0));
  results.push({
    id: "preview.records.required",
    ok: recordsPresent,
    detail: usesPreview
      ? `${previewEvents.length} events, ${previewDocuments.length} documents, ${previewPatches.length} patch batches`
      : "plan does not declare preview use",
  });

  const hasReplaySeed = previewDocuments.some((document) => {
    const eventTypes = new Set((document.events ?? []).map((event) => event.type));
    return document.version === 2 && eventTypes.has(4) && eventTypes.has(2);
  });
  const hasReplayPatches = previewPatches.some(
    (batch) => batch.version === 2 && (batch.events?.length ?? 0) > 0,
  );
  results.push({
    id: "preview.replayData",
    ok: !usesPreview || (hasReplaySeed && (!needsPatchData || hasReplayPatches)),
    detail: !usesPreview
      ? "plan does not declare preview use"
      : `rrweb seed=${String(hasReplaySeed)}, patches=${String(hasReplayPatches)}`,
  });

  const previewEnvelope = (candidate: Recording) => ({
    events: (candidate.previewEvents ?? []).map((event) => ({
      type: event.type,
      route: event.route,
      interactionType: event.interaction?.type,
      testId: event.interaction?.target.testId,
      checkpointActionId: event.checkpoint?.actionId,
    })),
    documents: (candidate.previewInitialDocuments ?? []).map((document) => ({
      version: document.version,
      documentId: document.documentId,
      route: document.route,
      eventTypes: (document.events ?? []).map((event) => event.type),
    })),
    patches: (candidate.previewPatchBatches ?? []).map((batch) => ({
      version: batch.version,
      source: batch.source,
      documentId: batch.documentId,
      route: batch.route,
      eventTypes: (batch.events ?? []).map((event) => event.type),
    })),
  });
  const previewRoundTrips =
    !usesPreview ||
    (decoded !== null &&
      JSON.stringify(previewEnvelope(recording)) === JSON.stringify(previewEnvelope(decoded)));
  results.push({
    id: "preview.roundTrip",
    ok: previewRoundTrips,
    detail: previewRoundTrips
      ? "preview event/document/patch envelopes survive SCR3 encode/decode"
      : "preview records changed or disappeared after SCR3 encode/decode",
  });

  let nextPreviewEventIndex = 0;
  const missingInteractions: string[] = [];
  for (const action of interactionActions) {
    const relativeIndex = previewEvents
      .slice(nextPreviewEventIndex)
      .findIndex((event) => previewEventMatchesAction(event, action));
    if (relativeIndex === -1) {
      missingInteractions.push(`${action.id} (${action.type})`);
      continue;
    }
    nextPreviewEventIndex += relativeIndex + 1;
  }
  results.push({
    id: "preview.interactions.authored",
    ok: !usesPreview || missingInteractions.length === 0,
    detail:
      missingInteractions.length === 0
        ? `${interactionActions.length} authored preview commands recorded in order`
        : `missing recorded commands: ${missingInteractions.join(", ")}`,
  });

  for (const action of plan.actions) {
    if (action.type !== "expect.preview") continue;
    const checkpointEvent = previewEvents.find(
      (event) => event.type === "preview_checkpoint" && event.checkpoint?.actionId === action.id,
    );
    const failure = previewCheckpointFailure(action, checkpointEvent);
    results.push({
      id: `checkpoint.preview.${action.id}`,
      ok: failure === null,
      detail: failure ?? "recorded DOM/route checkpoint matches the authored expectation",
      ...(failure === null ? {} : { diagnostic: await previewDiagnostic() }),
    });
  }

  const previewErrorLines = consoleLines.filter((line) => PREVIEW_ERROR_LINE.test(line));
  const previewRuntimeError = lastRuntimeSnapshot?.latestPreviewMessage;
  results.push({
    id: "preview.noErrors",
    ok: !previewRuntimeError && previewErrorLines.length === 0,
    detail: previewRuntimeError
      ? `${previewRuntimeError.kind}: ${previewRuntimeError.text}`
      : previewErrorLines.length > 0
        ? previewErrorLines.join(" | ")
        : "no preview console errors or exceptions",
  });

  return results;
}
