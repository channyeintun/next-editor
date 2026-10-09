// Replay-state resolution — public API.
//
// Split by track concern on top of a shared cursor core:
//   * cursor.ts    — replay time and cursor helpers shared by every track
//   * preview.ts   — preview iframe state
//   * workspace.ts — workspace/file/sidebar snapshot
//   * runtime.ts   — runtime snapshot
//   * slide.ts     — slide deck state
//   * whiteboard.ts — whiteboard scene state
//   * chat.ts      — coding-agent chat transcript
//
// Re-exported here so callers keep importing from "replayState" unchanged.

export { resolveReplayTime, isReplayResync } from "./cursor";
export { getPreviewReplayResult } from "./preview";
export { getWorkspaceReplayResult } from "./workspace";
export { getRuntimeReplayResult } from "./runtime";
export { getChatReplayResult } from "./chat";
export { getSlideReplayResult } from "./slide";
export { getWhiteboardReplayResult } from "./whiteboard";
