import { describe, expect, it } from "vite-plus/test";
import type { RuntimeRecordingSnapshot } from "../types/runtime";
import {
  applyRuntimeRecordingState,
  readRuntimeRecordingState,
  type LiveRuntimeRecordingState,
} from "./runtimeRecordingAdapter";
import {
  createRuntimePanelStore,
  selectPlaybackSnapshot,
  selectRecordingState,
} from "./runtimePanelStore";

function liveRuntime(overrides: Partial<LiveRuntimeRecordingState> = {}) {
  return {
    status: "ready",
    previewUrl: null,
    previewPort: null,
    lastOutput: "$ pnpm dev\n",
    activeCommand: null,
    errorMessage: null,
    terminalSessions: [{ id: "terminal-1", title: "Terminal 1", output: "$ " }],
    activeTerminalSessionId: "terminal-1",
    latestPreviewMessage: null,
    latestLifecycleEvent: null,
    ...overrides,
  } satisfies LiveRuntimeRecordingState;
}

describe("readRuntimeRecordingState", () => {
  it("records the WebContainer mode only when the runtime has a preview URL", () => {
    const store = createRuntimePanelStore();

    expect(readRuntimeRecordingState(liveRuntime(), store).mode).toBe("single-file");
    expect(
      readRuntimeRecordingState(
        liveRuntime({ previewUrl: "https://preview.example", previewPort: 5173 }),
        store,
      ).mode,
    ).toBe("webcontainer");
  });

  // The frame's key order is part of what the recording encodes.
  it("stores the live fields, then the dock's recordable state, in a fixed order", () => {
    const store = createRuntimePanelStore();

    const frame = readRuntimeRecordingState(
      { ...liveRuntime(), unlistedField: "not recorded" } as LiveRuntimeRecordingState,
      store,
    );

    expect(Object.keys(frame)).toEqual([
      "mode",
      "status",
      "previewUrl",
      "previewPort",
      "lastOutput",
      "activeCommand",
      "errorMessage",
      "terminalSessions",
      "activeTerminalSessionId",
      "latestPreviewMessage",
      "latestLifecycleEvent",
      "activeTab",
      "isCollapsed",
      "isFullHeight",
      "isSettingsOpen",
      "consoleLines",
      "terminalScrollLines",
    ]);
  });

  it("takes the dock's state from the panel store's recordable subset", () => {
    const store = createRuntimePanelStore();
    store.trigger.setActiveTab({ tab: "terminal" });
    store.trigger.setIsFullHeight({ fullHeight: true });
    store.trigger.setConsoleLines({ consoleLines: ["hello"] });
    // Viewer-only: never part of a recorded frame.
    store.trigger.setViewerFullHeight({ fullHeight: false });

    const frame = readRuntimeRecordingState(liveRuntime(), store);

    expect(frame).toMatchObject(selectRecordingState(store.getSnapshot().context));
    expect(frame).toMatchObject({ activeTab: "terminal", isFullHeight: true });
    expect(frame).not.toHaveProperty("viewerFullHeight");
  });
});

describe("applyRuntimeRecordingState", () => {
  it("shows the replayed frame as the dock's playback snapshot", () => {
    const store = createRuntimePanelStore();
    const frame: RuntimeRecordingSnapshot = { mode: "single-file", status: "idle" };

    applyRuntimeRecordingState(store, frame);

    expect(selectPlaybackSnapshot(store.getSnapshot().context)).toBe(frame);
  });
});
