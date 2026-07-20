import type { Recording } from "../core/src";
import { decompressBinaryToRecordings } from "../storage/recordingCodec";
import { isWorkspaceTextFile } from "../types/workspace";
import type { StudioPlan } from "./plan";
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
): void {
  // Trailing samples may land a beat after the audio-driven finalize; allow a
  // small overhang rather than failing renders on scheduler jitter.
  const overhangMs = 1_000;
  const monotonic = isMonotonicNonDecreasing(timestamps);
  const inBounds = timestamps.every(
    (timestamp) =>
      Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= durationMs + overhangMs,
  );
  results.push({
    id,
    ok: monotonic && inBounds,
    detail: monotonic
      ? inBounds
        ? `${timestamps.length} events, monotonic and in bounds`
        : `event outside [0, ${Math.round(durationMs + overhangMs)}]ms`
      : "timestamps regress",
  });
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
}

export async function runArtifactChecks({
  recording,
  neBytes,
  plan,
}: ArtifactCheckInput): Promise<StudioCheckResult[]> {
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

  // duration.finite
  const duration = recording.duration;
  results.push({
    id: "duration.finite",
    ok: Number.isFinite(duration) && duration > 0,
    detail: `duration ${Math.round(duration)}ms`,
  });

  // events.monotonic — per track
  checkEventTrack(
    "frames.monotonic",
    recording.frames.map((frame) => frame.timestamp),
    duration,
    results,
  );
  checkEventTrack(
    "cursor.monotonic",
    (recording.cursorEvents ?? []).map((event) => event.timestamp),
    duration,
    results,
  );
  checkEventTrack(
    "workspace.monotonic",
    (recording.workspaceEvents ?? []).map((event) => event.timestamp),
    duration,
    results,
  );
  checkEventTrack(
    "runtime.monotonic",
    (recording.runtimeEvents ?? []).map((event) => event.timestamp),
    duration,
    results,
  );

  // tracks.required
  const trackKinds = new Set((recording.tracks ?? []).map((track) => track.kind));
  const requiredKinds = ["editor", "audio", "workspace", "runtime", "cursor"] as const;
  const missingKinds = requiredKinds.filter((kind) => !trackKinds.has(kind));
  results.push({
    id: "tracks.required",
    ok: missingKinds.length === 0,
    detail:
      missingKinds.length === 0
        ? `tracks: ${Array.from(trackKinds).sort().join(", ")}`
        : `missing tracks: ${missingKinds.join(", ")}`,
  });

  // audio.external
  const hasAudio =
    recording.audioSource === "external" &&
    (recording.audioBlob instanceof Blob || Boolean(recording.audioFile));
  const audioOffset = recording.audioStartOffsetMs ?? 0;
  results.push({
    id: "audio.external",
    ok: hasAudio && Number.isFinite(audioOffset) && audioOffset >= 0,
    detail: hasAudio
      ? `external audio attached, startOffset ${audioOffset}ms`
      : "external audio missing from the recording",
  });

  // captions.attached — cue times monotonic and inside the recording
  const track = (recording.captions ?? []).find(
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

  // runtime.noErrors + expect.output re-checked against the *recorded* console
  const lastRuntimeSnapshot =
    recording.runtimeSnapshot ?? (recording.runtimeEvents ?? []).at(-1)?.snapshot ?? null;
  const consoleLines = lastRuntimeSnapshot?.consoleLines ?? [];
  const errorLines = consoleLines.filter((line) => line.includes("error]"));
  results.push({
    id: "runtime.noErrors",
    ok: errorLines.length === 0,
    detail: errorLines.length === 0 ? "no error-prefixed console lines" : errorLines.join(" | "),
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
      const files = workspaceTextFilesOf(recording);
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

  return results;
}

/** Hash of the recording's final workspace text files (repeatability + manifest). */
export async function finalWorkspaceHashOf(recording: Recording): Promise<string> {
  return hashWorkspaceFiles(workspaceTextFilesOf(recording));
}
