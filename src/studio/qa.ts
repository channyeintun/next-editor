import type { Recording, RecordingTrackKind } from "../core/src";
import { resolveLatestRuntimeSnapshot } from "../core/src/runtimeTrack";
import { RECORDING_SCHEMA_VERSION } from "../core/src/utils/deltaTypes";
import { decompressBinaryToRecording } from "../storage/recordingCodec";
import type { StudioPlan } from "./plan";
import { planUsesPreview, previewGateChecks, type PreviewScreenshotCapture } from "./qaPreview";
import { runtimeGateChecks } from "./qaRuntime";
import type { StudioCheckResult } from "./report";

/**
 * Mechanical artifact gates (docs/agent-lesson-production.md §8): decode the
 * encoded stream back, assert structural invariants (finite duration,
 * monotonic in-bounds event times, required tracks), then assert the semantic
 * checkpoints the plan declares. Every check is report-friendly — id, ok,
 * human-readable detail — and any failed check rejects the build. The
 * structural gates live here; the preview gates (qaPreview.ts) and the runtime
 * gates (qaRuntime.ts) follow them, in that order.
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

export interface ArtifactCheckInput {
  recording: Recording;
  /** The encoded `.ne` stream, decoded again to prove the artifact round-trips. */
  neBytes: Uint8Array;
  plan: StudioPlan;
  /** Captured lazily only when an artifact-level preview checkpoint fails. */
  capturePreviewScreenshot?: PreviewScreenshotCapture;
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
    decoded = await decompressBinaryToRecording(neBytes);
    results.push({
      id: "recording.decodes",
      ok: decoded.version === RECORDING_SCHEMA_VERSION && decoded.streamFinalized === true,
      detail: `SCR3 decodes; ${neBytes.byteLength} bytes, finalized=${String(decoded.streamFinalized)}`,
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

  // The console both gate groups read, from the *encoded* artifact.
  const lastRuntimeSnapshot =
    artifactRecording.runtimeSnapshot ??
    resolveLatestRuntimeSnapshot(artifactRecording.runtimeEvents);
  const consoleLines = lastRuntimeSnapshot?.consoleLines ?? [];
  results.push(
    ...(await previewGateChecks({
      recording,
      decoded,
      artifactRecording,
      plan,
      lastRuntimeSnapshot,
      consoleLines,
      capturePreviewScreenshot,
    })),
    ...runtimeGateChecks({ artifactRecording, plan, lastRuntimeSnapshot, consoleLines }),
  );

  return { checks: results, artifactRecording };
}
