import type { Recording } from "../core/src";
import type { ActionReceipt, StudioCheckResult } from "./report";
import { workspaceTextFilesOf } from "./qa";
import { hashWorkspaceFiles, sha256Hex } from "./hash";

/**
 * Normalized repeatability comparison (docs/agent-lesson-production.md §8):
 * two renders of the same compiled plan must agree on the logical action
 * sequence, final workspace content, captions, audio bytes, and recorded
 * console output; timestamps only have to agree within a tolerance — raw byte
 * equality of the streams is explicitly a non-goal.
 */

export interface RenderSemantics {
  actionSequence: { actionId: string; actionType: string; status: string }[];
  actionStartsMs: Record<string, number | null>;
  finalWorkspaceHash: string;
  captionText: string;
  audioSha256: string;
  consoleLines: string[];
  durationMs: number;
}

export async function extractRenderSemantics(
  recording: Recording,
  receipts: readonly ActionReceipt[],
  audioBytes: Uint8Array,
): Promise<RenderSemantics> {
  const lastRuntimeSnapshot =
    recording.runtimeSnapshot ?? (recording.runtimeEvents ?? []).at(-1)?.snapshot ?? null;

  return {
    actionSequence: receipts.map((receipt) => ({
      actionId: receipt.actionId,
      actionType: receipt.actionType,
      status: receipt.status,
    })),
    actionStartsMs: Object.fromEntries(
      receipts.map((receipt) => [receipt.actionId, receipt.startedAtMs]),
    ),
    finalWorkspaceHash: await hashWorkspaceFiles(workspaceTextFilesOf(recording)),
    captionText: (recording.captions ?? [])
      .flatMap((track) => track.cues.map((cue) => cue.text))
      .join("\n"),
    audioSha256: await sha256Hex(audioBytes),
    consoleLines: lastRuntimeSnapshot?.consoleLines ?? [],
    durationMs: recording.duration,
  };
}

export interface CompareOptions {
  /** Max |run1 − run2| action-start difference (ms). */
  actionStartToleranceMs: number;
  /** Max |run1 − run2| total duration difference (ms). */
  durationToleranceMs: number;
}

export const DEFAULT_COMPARE_OPTIONS: CompareOptions = {
  actionStartToleranceMs: 300,
  durationToleranceMs: 500,
};

export function compareRenderSemantics(
  first: RenderSemantics,
  second: RenderSemantics,
  options: CompareOptions = DEFAULT_COMPARE_OPTIONS,
): StudioCheckResult[] {
  const results: StudioCheckResult[] = [];

  const sequencesEqual =
    first.actionSequence.length === second.actionSequence.length &&
    first.actionSequence.every((entry, index) => {
      const other = second.actionSequence[index];
      return (
        entry.actionId === other.actionId &&
        entry.actionType === other.actionType &&
        entry.status === other.status
      );
    });
  results.push({
    id: "repeat.actionSequence",
    ok: sequencesEqual,
    detail: sequencesEqual
      ? `${first.actionSequence.length} actions in identical order and status`
      : "action id/type/status sequences differ",
  });

  results.push({
    id: "repeat.finalWorkspace",
    ok: first.finalWorkspaceHash === second.finalWorkspaceHash,
    detail:
      first.finalWorkspaceHash === second.finalWorkspaceHash
        ? `workspace hash ${first.finalWorkspaceHash.slice(0, 12)}…`
        : "final workspace hashes differ",
  });

  results.push({
    id: "repeat.captions",
    ok: first.captionText === second.captionText,
    detail:
      first.captionText === second.captionText ? "caption text identical" : "caption text differs",
  });

  results.push({
    id: "repeat.audio",
    ok: first.audioSha256 === second.audioSha256,
    detail:
      first.audioSha256 === second.audioSha256
        ? `audio ${first.audioSha256.slice(0, 12)}…`
        : "audio bytes differ",
  });

  const consoleEqual =
    first.consoleLines.length === second.consoleLines.length &&
    first.consoleLines.every((line, index) => line === second.consoleLines[index]);
  results.push({
    id: "repeat.console",
    ok: consoleEqual,
    detail: consoleEqual
      ? `${first.consoleLines.length} recorded console lines identical`
      : "recorded console lines differ",
  });

  let worstStartDeltaMs = 0;
  let comparableStarts = true;
  for (const [actionId, firstStart] of Object.entries(first.actionStartsMs)) {
    const secondStart = second.actionStartsMs[actionId];
    if (firstStart === null || secondStart === null || secondStart === undefined) {
      comparableStarts = comparableStarts && firstStart === (secondStart ?? null);
      continue;
    }
    worstStartDeltaMs = Math.max(worstStartDeltaMs, Math.abs(firstStart - secondStart));
  }
  const timingOk = comparableStarts && worstStartDeltaMs <= options.actionStartToleranceMs;
  results.push({
    id: "repeat.actionTiming",
    ok: timingOk,
    detail: `worst action-start delta ${Math.round(worstStartDeltaMs)}ms (tolerance ${options.actionStartToleranceMs}ms)`,
  });

  const durationDeltaMs = Math.abs(first.durationMs - second.durationMs);
  results.push({
    id: "repeat.duration",
    ok: durationDeltaMs <= options.durationToleranceMs,
    detail: `duration delta ${Math.round(durationDeltaMs)}ms (tolerance ${options.durationToleranceMs}ms)`,
  });

  return results;
}
