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
  /**
   * Hash of the compiled plan this render performed. Two renders are only
   * comparable when their plan hashes match — a differing hash means the
   * script (narration, actions, slides, …) changed between runs, and a
   * comparison would report intentional edits as repeatability failures.
   */
  planSha256: string;
  actionSequence: { actionId: string; actionType: string; status: string }[];
  actionStartsMs: Record<string, number | null>;
  finalWorkspaceHash: string;
  captionText: string;
  audioSha256: string;
  consoleLines: string[];
  previewState: {
    finalRoute: string | null;
    checkpoints: {
      actionId: string;
      route: string;
      target?: {
        attributes: Record<string, string>;
        tagName: string;
        testId: string;
        text: string;
        value: string | null;
      };
    }[];
  };
  previewInteractionSequence: {
    type: string;
    mode?: string;
    route?: string;
    testId?: string;
    value?: string;
    scrollTop?: number;
    scrollLeft?: number;
  }[];
  durationMs: number;
}

function normalizePreviewState(recording: Recording): RenderSemantics["previewState"] {
  const events = recording.previewEvents ?? [];
  const checkpoints = events.flatMap((event) => {
    const checkpoint = event.checkpoint;
    if (event.type !== "preview_checkpoint" || !checkpoint) return [];
    const target = checkpoint.target
      ? {
          ...checkpoint.target,
          attributes: Object.fromEntries(
            Object.entries(checkpoint.target.attributes).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
        }
      : undefined;
    return [{ actionId: checkpoint.actionId, route: checkpoint.route, target }];
  });
  const finalRoute =
    events
      .map((event) => event.checkpoint?.route ?? event.route)
      .filter((route): route is string => typeof route === "string")
      .at(-1) ??
    recording.previewInitialDocuments?.at(-1)?.route ??
    null;
  return { finalRoute, checkpoints };
}

function normalizePreviewInteractions(
  recording: Recording,
): RenderSemantics["previewInteractionSequence"] {
  return (recording.previewEvents ?? []).flatMap((event) => {
    if (event.type === "preview_open") {
      return [{ type: "open", mode: event.mode }];
    }
    if (event.type === "preview_route_change") {
      return [{ type: "route", route: event.route }];
    }
    if (event.type === "preview_scroll") {
      return [
        {
          type: "scroll",
          scrollTop: event.scrollTop,
          scrollLeft: event.scrollLeft,
        },
      ];
    }
    const interaction = event.interaction;
    if (
      event.type !== "preview_interaction" ||
      !interaction ||
      (interaction.type !== "click" &&
        interaction.type !== "input" &&
        interaction.type !== "scroll")
    ) {
      return [];
    }
    return [
      {
        type: interaction.type,
        testId: interaction.target.testId,
        value: interaction.data?.value,
        scrollTop: interaction.data?.scrollTop,
        scrollLeft: interaction.data?.scrollLeft,
      },
    ];
  });
}

export async function extractRenderSemantics(
  recording: Recording,
  receipts: readonly ActionReceipt[],
  audioBytes: Uint8Array,
  planSha256: string,
): Promise<RenderSemantics> {
  const lastRuntimeSnapshot =
    recording.runtimeSnapshot ?? (recording.runtimeEvents ?? []).at(-1)?.snapshot ?? null;

  return {
    planSha256,
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
    previewState: normalizePreviewState(recording),
    previewInteractionSequence: normalizePreviewInteractions(recording),
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

  const previewStateEqual =
    JSON.stringify(first.previewState ?? { finalRoute: null, checkpoints: [] }) ===
    JSON.stringify(second.previewState ?? { finalRoute: null, checkpoints: [] });
  results.push({
    id: "repeat.previewState",
    ok: previewStateEqual,
    detail: previewStateEqual
      ? `${first.previewState?.checkpoints.length ?? 0} normalized preview checkpoints identical`
      : "normalized preview DOM/route state differs",
  });

  const previewInteractionsEqual =
    JSON.stringify(first.previewInteractionSequence ?? []) ===
    JSON.stringify(second.previewInteractionSequence ?? []);
  results.push({
    id: "repeat.previewInteractions",
    ok: previewInteractionsEqual,
    detail: previewInteractionsEqual
      ? `${first.previewInteractionSequence?.length ?? 0} preview interactions identical`
      : "recorded preview interaction sequences differ",
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
