import type { RuntimePanelRecordingState, RuntimeRecordingSnapshot } from "../types/runtime";
import { selectRecordingState, type RuntimePanelStoreInstance } from "./runtimePanelStore";

// How the editor machine records and replays the runtime dock: NextEditorProvider's
// getRuntimeSnapshot and applyRuntimeSnapshot hooks, over the live runtime's
// recording snapshot and the app's runtime panel store.

/** The live runtime's side of a recorded runtime frame, as the runtime session reports it. */
export type LiveRuntimeRecordingState = Required<
  Omit<RuntimeRecordingSnapshot, "mode" | keyof RuntimePanelRecordingState>
>;

/**
 * The runtime as a recording frame stores it: the live runtime's fields, then the
 * dock's recordable state. The fields are listed one by one, in the order the
 * frame has always stored them, so a field the live runtime gains is not recorded
 * until it is added here. A runtime with a preview URL is the WebContainer one;
 * otherwise the lesson runs single-file.
 */
export function readRuntimeRecordingState(
  snapshot: LiveRuntimeRecordingState,
  store: RuntimePanelStoreInstance,
): RuntimeRecordingSnapshot {
  return {
    mode: snapshot.previewUrl ? "webcontainer" : "single-file",
    status: snapshot.status,
    previewUrl: snapshot.previewUrl,
    previewPort: snapshot.previewPort,
    lastOutput: snapshot.lastOutput,
    activeCommand: snapshot.activeCommand,
    errorMessage: snapshot.errorMessage,
    terminalSessions: snapshot.terminalSessions,
    activeTerminalSessionId: snapshot.activeTerminalSessionId,
    latestPreviewMessage: snapshot.latestPreviewMessage,
    latestLifecycleEvent: snapshot.latestLifecycleEvent,
    ...selectRecordingState(store.getSnapshot().context),
  };
}

/** Shows a replayed runtime frame in the dock. */
export function applyRuntimeRecordingState(
  store: RuntimePanelStoreInstance,
  snapshot: RuntimeRecordingSnapshot,
): void {
  store.trigger.setPlaybackSnapshot({ snapshot });
}
