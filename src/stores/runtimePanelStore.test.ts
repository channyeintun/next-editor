import { describe, expect, it } from "vite-plus/test";
import {
  createRuntimePanelStore,
  selectIsCollapsed,
  selectIsFullHeight,
  selectPlaybackSnapshot,
  selectRecordingState,
  selectTerminalScrollLines,
  selectViewerFullHeight,
  setTerminalScrollLineIfChanged,
} from "./runtimePanelStore";

describe("runtimePanelStore viewer full height", () => {
  it("starts with no viewer choice", () => {
    const store = createRuntimePanelStore();

    expect(selectViewerFullHeight(store.getSnapshot().context)).toBeNull();
  });

  it("keeps the viewer's choice apart from the live height", () => {
    const store = createRuntimePanelStore();

    store.trigger.setViewerFullHeight({ fullHeight: true });

    expect(selectViewerFullHeight(store.getSnapshot().context)).toBe(true);
    expect(selectIsFullHeight(store.getSnapshot().context)).toBe(false);

    store.trigger.setViewerFullHeight({ fullHeight: false });
    expect(selectViewerFullHeight(store.getSnapshot().context)).toBe(false);

    store.trigger.clearViewerFullHeight();
    expect(selectViewerFullHeight(store.getSnapshot().context)).toBeNull();
  });

  it("leaves the store untouched when nothing changes", () => {
    const store = createRuntimePanelStore();
    store.trigger.setViewerFullHeight({ fullHeight: true });
    const before = store.getSnapshot().context;

    store.trigger.setViewerFullHeight({ fullHeight: true });
    expect(store.getSnapshot().context).toBe(before);

    store.trigger.clearViewerFullHeight();
    const cleared = store.getSnapshot().context;
    store.trigger.clearViewerFullHeight();
    expect(store.getSnapshot().context).toBe(cleared);
  });

  it("never puts the viewer's choice into what a recording captures", () => {
    const store = createRuntimePanelStore();

    store.trigger.setViewerFullHeight({ fullHeight: true });
    const recorded = selectRecordingState(store.getSnapshot().context);

    expect(recorded.isFullHeight).toBe(false);
    expect(recorded).not.toHaveProperty("viewerFullHeight");
  });
});

describe("runtimePanelStore viewer collapse", () => {
  it("collapses the live dock and the replayed frame on screen together", () => {
    const store = createRuntimePanelStore();
    const replayed = { mode: "single-file", status: "idle", isCollapsed: false } as const;
    store.trigger.setPlaybackSnapshot({ snapshot: replayed });

    store.trigger.setViewerCollapsed({ collapsed: true });

    const context = store.getSnapshot().context;
    expect(selectIsCollapsed(context)).toBe(true);
    expect(selectPlaybackSnapshot(context)).toEqual({ ...replayed, isCollapsed: true });
    // The replayed frame belongs to the recording's runtime track: it is copied, not changed.
    expect(replayed.isCollapsed).toBe(false);
  });

  it("collapses only the live dock when no replayed frame is shown", () => {
    const store = createRuntimePanelStore();

    store.trigger.setViewerCollapsed({ collapsed: true });

    expect(selectIsCollapsed(store.getSnapshot().context)).toBe(true);
    expect(selectPlaybackSnapshot(store.getSnapshot().context)).toBeNull();
  });

  it("leaves the store untouched when both already show it", () => {
    const store = createRuntimePanelStore();
    store.trigger.setPlaybackSnapshot({
      snapshot: { mode: "single-file", status: "idle", isCollapsed: true },
    });
    store.trigger.setIsCollapsed({ collapsed: true });
    const before = store.getSnapshot().context;

    store.trigger.setViewerCollapsed({ collapsed: true });

    expect(store.getSnapshot().context).toBe(before);
  });
});

describe("setTerminalScrollLineIfChanged", () => {
  it("updates only that surface's line and keeps the others", () => {
    const store = createRuntimePanelStore();
    store.trigger.setTerminalScrollLines({ terminalScrollLines: { runner: 3, console: 7 } });

    setTerminalScrollLineIfChanged(store, "runner", 12);
    setTerminalScrollLineIfChanged(store, "shell-1", 0);

    expect(selectTerminalScrollLines(store.getSnapshot().context)).toEqual({
      runner: 12,
      console: 7,
      "shell-1": 0,
    });
  });

  it("writes nothing, and so notifies no one, when the line is unchanged", () => {
    const store = createRuntimePanelStore();
    setTerminalScrollLineIfChanged(store, "runner", 5);
    const before = store.getSnapshot().context;
    let notifications = 0;
    const subscription = store.subscribe(() => {
      notifications += 1;
    });

    setTerminalScrollLineIfChanged(store, "runner", 5);

    expect(notifications).toBe(0);
    expect(store.getSnapshot().context).toBe(before);

    setTerminalScrollLineIfChanged(store, "runner", 6);
    expect(notifications).toBe(1);
    subscription.unsubscribe();
  });
});
