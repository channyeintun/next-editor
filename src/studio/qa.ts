import type { Recording, RecordingTrackKind } from "../core/src";
import { decompressBinaryToRecordings } from "../storage/recordingCodec";
import { isWorkspaceTextFile } from "../types/workspace";
import type { StudioPlan, StudioPlanAction } from "./plan";
import type { StudioCheckResult } from "./report";
import { hashWorkspaceFiles } from "./hash";

/**
 * Mechanical artifact gates (docs/agent-lesson-production.md §8): decode the
 * encoded stream back, assert structural invariants (finite duration,
 * monotonic in-bounds event times, required tracks), then assert the semantic
 * checkpoints the plan declares. Every check is report-friendly — id, ok,
 * human-readable detail — and any failed check rejects the build.
 */

function isMonotonicNonDecreasing(timestamps: readonly number[]): boolean {
  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i] < timestamps[i - 1]) {
      return false;
    }
  }
  return true;
}

function checkEventTrack(
  id: string,
  timestamps: readonly number[],
  durationMs: number,
  results: StudioCheckResult[],
  required = false,
): void {
  // Trailing samples may land a beat after the audio-driven finalize; allow a
  // small overhang rather than failing renders on scheduler jitter.
  const overhangMs = 1_000;
  const present = !required || timestamps.length > 0;
  const monotonic = isMonotonicNonDecreasing(timestamps);
  const inBounds = timestamps.every(
    (timestamp) =>
      Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= durationMs + overhangMs,
  );
  results.push({
    id,
    ok: present && monotonic && inBounds,
    detail: !present
      ? "required event stream is empty"
      : monotonic
        ? inBounds
          ? `${timestamps.length} events, monotonic and in bounds`
          : `event outside [0, ${Math.round(durationMs + overhangMs)}]ms`
        : "timestamps regress",
  });
}

type RecordedPreviewEvent = NonNullable<Recording["previewEvents"]>[number];
type PreviewCommandAction = Extract<
  StudioPlanAction,
  {
    type: "preview.open" | "preview.click" | "preview.input" | "preview.scroll" | "preview.route";
  }
>;
type PreviewExpectationAction = Extract<StudioPlanAction, { type: "expect.preview" }>;

function planUsesPreview(plan: StudioPlan): boolean {
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
  if (action.route !== undefined && checkpoint.route !== action.route) {
    return `route is ${JSON.stringify(checkpoint.route)}, expected ${JSON.stringify(action.route)}`;
  }
  if (action.target && checkpoint.target?.testId !== action.target.value) {
    return `target data-testid is ${JSON.stringify(checkpoint.target?.testId)}, expected ${JSON.stringify(action.target.value)}`;
  }
  if (action.textContains !== undefined && !checkpoint.target?.text.includes(action.textContains)) {
    return `target text does not contain ${JSON.stringify(action.textContains)}`;
  }
  if (action.value !== undefined && checkpoint.target?.value !== action.value) {
    return `target value is ${JSON.stringify(checkpoint.target?.value)}, expected ${JSON.stringify(action.value)}`;
  }
  if (
    action.attribute !== undefined &&
    checkpoint.target?.attributes[action.attribute.name] !== action.attribute.value
  ) {
    return `target attribute ${JSON.stringify(action.attribute.name)} is ${JSON.stringify(checkpoint.target?.attributes[action.attribute.name])}, expected ${JSON.stringify(action.attribute.value)}`;
  }
  return null;
}

export function workspaceTextFilesOf(recording: Recording): Record<string, string> {
  const files: Record<string, string> = {};
  const project = recording.workspaceSnapshot?.project;
  if (!project) {
    return files;
  }
  for (const [path, file] of Object.entries(project.files)) {
    if (isWorkspaceTextFile(file)) {
      files[path] = file.content;
    }
  }
  return files;
}

export interface ArtifactCheckInput {
  recording: Recording;
  /** The encoded `.ne` stream, decoded again to prove the artifact round-trips. */
  neBytes: Uint8Array;
  plan: StudioPlan;
  /** Captured lazily only when an artifact-level preview checkpoint fails. */
  capturePreviewScreenshot?: () => Promise<{ dataUrl: string; height: number; width: number }>;
}

export interface ArtifactCheckOutput {
  checks: StudioCheckResult[];
  /**
   * The recording every gate was evaluated against: the decoded artifact when
   * `neBytes` round-tripped, and the in-memory recording only when decode failed
   * (in which case `recording.decodes` failed and the build fails closed). The
   * caller must derive the manifest's final-workspace hash and repeatability
   * semantics from this same object so nothing is vouched for that is absent
   * from the encoded `.ne`.
   */
  artifactRecording: Recording;
}

export async function runArtifactChecks({
  recording,
  neBytes,
  plan,
  capturePreviewScreenshot,
}: ArtifactCheckInput): Promise<ArtifactCheckOutput> {
  const results: StudioCheckResult[] = [];

  // recording.decodes
  let decoded: Recording | null = null;
  try {
    const decodedRecordings = await decompressBinaryToRecordings(neBytes);
    decoded = decodedRecordings[0] ?? null;
    results.push({
      id: "recording.decodes",
      ok: decoded !== null && decoded.version === 4 && decoded.streamFinalized === true,
      detail: decoded
        ? `SCR3 decodes; ${neBytes.byteLength} bytes, finalized=${String(decoded.streamFinalized)}`
        : "decode produced no recording",
    });
  } catch (error) {
    results.push({
      id: "recording.decodes",
      ok: false,
      detail: error instanceof Error ? error.message : "decode threw",
    });
  }

  const artifactRecording = decoded ?? recording;
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

  // Every structural and semantic gate below inspects the decoded artifact, not
  // the in-memory recording: the entire point of round-tripping is to prove the
  // *encoded* bytes carry the state QA vouches for. `artifactRecording` falls
  // back to the in-memory recording only when decode failed, in which case
  // `recording.decodes` has already failed and the build fails closed regardless.

  // duration.finite
  const duration = artifactRecording.duration;
  results.push({
    id: "duration.finite",
    ok: Number.isFinite(duration) && duration > 0,
    detail: `duration ${Math.round(duration)}ms`,
  });

  // events.monotonic — per track
  checkEventTrack(
    "frames.monotonic",
    artifactRecording.frames.map((frame) => frame.timestamp),
    duration,
    results,
    true,
  );
  checkEventTrack(
    "cursor.monotonic",
    (artifactRecording.cursorEvents ?? []).map((event) => event.timestamp),
    duration,
    results,
    true,
  );
  checkEventTrack(
    "workspace.monotonic",
    (artifactRecording.workspaceEvents ?? []).map((event) => event.timestamp),
    duration,
    results,
    true,
  );
  checkEventTrack(
    "runtime.monotonic",
    (artifactRecording.runtimeEvents ?? []).map((event) => event.timestamp),
    duration,
    results,
    true,
  );
  checkEventTrack(
    "preview.events.monotonic",
    (artifactRecording.previewEvents ?? []).map((event) => event.timestamp),
    duration,
    results,
  );
  checkEventTrack(
    "preview.documents.monotonic",
    (artifactRecording.previewInitialDocuments ?? []).map((document) => document.time),
    duration,
    results,
  );
  checkEventTrack(
    "preview.patches.monotonic",
    (artifactRecording.previewPatchBatches ?? []).map((batch) => batch.time),
    duration,
    results,
  );

  // tracks.required
  const trackKinds = new Set((artifactRecording.tracks ?? []).map((track) => track.kind));
  const requiredKinds: RecordingTrackKind[] = ["editor", "audio", "workspace", "runtime", "cursor"];
  if (usesPreview) {
    requiredKinds.push("preview");
  }
  const missingKinds = requiredKinds.filter((kind) => !trackKinds.has(kind));
  results.push({
    id: "tracks.required",
    ok: missingKinds.length === 0,
    detail:
      missingKinds.length === 0
        ? `tracks: ${Array.from(trackKinds).sort().join(", ")}`
        : `missing tracks: ${missingKinds.join(", ")}`,
  });

  // audio.external — the encoded stream externalizes the blob to `audioFile`, so
  // the decoded artifact proves external audio by `audioSource` + the reference.
  const hasAudio =
    artifactRecording.audioSource === "external" &&
    (artifactRecording.audioBlob instanceof Blob || Boolean(artifactRecording.audioFile));
  const audioOffset = artifactRecording.audioStartOffsetMs ?? 0;
  results.push({
    id: "audio.external",
    ok: hasAudio && Number.isFinite(audioOffset) && audioOffset >= 0,
    detail: hasAudio
      ? `external audio attached, startOffset ${audioOffset}ms`
      : "external audio missing from the recording",
  });

  // captions.attached — cue times monotonic and inside the recording
  const track = (artifactRecording.captions ?? []).find(
    (candidate) => candidate.id === plan.narration.captions.id,
  );
  if (!track) {
    results.push({ id: "captions.attached", ok: false, detail: "caption track missing" });
  } else {
    let cuesOk = track.cues.length > 0;
    for (let i = 0; i < track.cues.length; i++) {
      const cue = track.cues[i];
      if (
        cue.end <= cue.start ||
        cue.start < 0 ||
        cue.end > duration + 1_000 ||
        (i > 0 && cue.start < track.cues[i - 1].end)
      ) {
        cuesOk = false;
        break;
      }
    }
    results.push({
      id: "captions.attached",
      ok: cuesOk,
      detail: cuesOk
        ? `${track.cues.length} cues, monotonic and inside ${Math.round(duration)}ms`
        : "cue timing out of bounds or overlapping",
    });
  }

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

  // runtime.noErrors + expect.output re-checked against the *encoded* console
  const lastRuntimeSnapshot =
    artifactRecording.runtimeSnapshot ??
    (artifactRecording.runtimeEvents ?? []).at(-1)?.snapshot ??
    null;
  const consoleLines = lastRuntimeSnapshot?.consoleLines ?? [];
  const previewErrorLines = consoleLines.filter((line) => /^\[preview:error\]/i.test(line));
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
  const errorLines = consoleLines.filter((line) => line.includes("error]"));
  const runtimeError =
    lastRuntimeSnapshot?.errorMessage ??
    (lastRuntimeSnapshot?.latestLifecycleEvent?.kind === "internal-error"
      ? lastRuntimeSnapshot.latestLifecycleEvent.text
      : null);
  results.push({
    id: "runtime.noErrors",
    ok: errorLines.length === 0 && !runtimeError,
    detail:
      runtimeError ??
      (errorLines.length === 0
        ? "no runtime or error-prefixed console failures"
        : errorLines.join(" | ")),
  });

  for (const action of plan.actions) {
    if (action.type === "expect.output") {
      const matched = consoleLines.some((line) => line.includes(action.contains));
      results.push({
        id: `checkpoint.output.${action.id}`,
        ok: matched,
        detail: matched
          ? `recorded console contains ${JSON.stringify(action.contains)}`
          : `recorded console never contains ${JSON.stringify(action.contains)}`,
      });
    }
    if (action.type === "expect.file") {
      const files = workspaceTextFilesOf(artifactRecording);
      const content = files[action.path];
      const matched = typeof content === "string" && content.includes(action.contains);
      results.push({
        id: `checkpoint.file.${action.id}`,
        ok: matched,
        detail: matched
          ? `final "${action.path}" contains ${JSON.stringify(action.contains)}`
          : `final "${action.path}" missing ${JSON.stringify(action.contains)}`,
      });
    }
  }

  return { checks: results, artifactRecording };
}

/** Hash of the recording's final workspace text files (repeatability + manifest). */
export async function finalWorkspaceHashOf(recording: Recording): Promise<string> {
  return hashWorkspaceFiles(workspaceTextFilesOf(recording));
}
