import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { selectIsFullHeight, selectViewerFullHeight } from "../stores/runtimePanelStore";
import type { RuntimeRecordingSnapshot } from "../types/runtime";

const metadata = vi.hoisted(() => ({
  current: {
    currentRecording: null as unknown,
    isPlaying: false,
    isRecording: false,
    isReplayLoaded: false,
  },
}));

vi.mock("./useNextEditorContext", () => ({
  useNextEditorMetadata: () => metadata.current,
}));

import {
  RuntimePanelStoreProvider,
  useRuntimePanelStore,
} from "../contexts/RuntimePanelStoreContext";
import { useRuntimeDockLayout } from "./useRuntimeDockLayout";

function Providers({ children }: PropsWithChildren) {
  return <RuntimePanelStoreProvider>{children}</RuntimePanelStoreProvider>;
}

function renderLayout() {
  return renderHook(
    () => ({ layout: useRuntimeDockLayout(), store: useRuntimePanelStore().store }),
    { wrapper: Providers },
  );
}

function replaying(runtimeSnapshot: RuntimeRecordingSnapshot) {
  metadata.current = {
    currentRecording: { runtimeSnapshot },
    isPlaying: true,
    isRecording: false,
    isReplayLoaded: true,
  };
}

describe("useRuntimeDockLayout", () => {
  beforeEach(() => {
    metadata.current = {
      currentRecording: null,
      isPlaying: false,
      isRecording: false,
      isReplayLoaded: false,
    };
  });

  it("shows the live layout when nothing is replaying", () => {
    const { result } = renderLayout();

    act(() => {
      result.current.store.trigger.setActiveTab({ tab: "agent" });
      result.current.store.trigger.setIsCollapsed({ collapsed: true });
      result.current.store.trigger.setIsFullHeight({ fullHeight: true });
    });

    expect(result.current.layout).toEqual({
      activeTab: "agent",
      isCollapsed: true,
      isFullHeight: true,
      recordedRuntimeSnapshot: null,
      isPlaybackSnapshotActive: false,
      displayActiveTab: "agent",
      displayIsCollapsed: true,
      displayIsFullHeight: true,
      toggleFullHeight: expect.any(Function),
    });
  });

  it("shows the recorded layout during playback and still reports the live one", () => {
    const snapshot: RuntimeRecordingSnapshot = {
      mode: "single-file",
      status: "idle",
      activeTab: "agent",
      isCollapsed: true,
      isFullHeight: true,
    };
    replaying(snapshot);

    const { result } = renderLayout();

    expect(result.current.layout).toEqual({
      activeTab: "runner",
      isCollapsed: false,
      isFullHeight: false,
      recordedRuntimeSnapshot: snapshot,
      isPlaybackSnapshotActive: true,
      displayActiveTab: "agent",
      displayIsCollapsed: true,
      displayIsFullHeight: true,
      toggleFullHeight: expect.any(Function),
    });
  });

  it("opens the runner tab at normal height for a recording without a dock layout", () => {
    replaying({ mode: "single-file", status: "idle" });
    const { result } = renderLayout();

    act(() => {
      result.current.store.trigger.setActiveTab({ tab: "agent" });
      result.current.store.trigger.setIsCollapsed({ collapsed: true });
      result.current.store.trigger.setIsFullHeight({ fullHeight: true });
    });

    expect(result.current.layout).toMatchObject({
      isPlaybackSnapshotActive: true,
      displayActiveTab: "runner",
      displayIsCollapsed: false,
      displayIsFullHeight: false,
    });
  });

  it("shows the live layout while a take is being recorded", () => {
    metadata.current = {
      currentRecording: {
        runtimeSnapshot: { mode: "single-file", status: "idle", activeTab: "agent" },
      },
      isPlaying: true,
      isRecording: true,
      isReplayLoaded: false,
    };

    const { result } = renderLayout();

    expect(result.current.layout).toMatchObject({
      isPlaybackSnapshotActive: false,
      recordedRuntimeSnapshot: null,
      displayActiveTab: "runner",
    });
  });

  describe("the viewer's full-height choice", () => {
    const recorded = (isFullHeight: boolean): RuntimeRecordingSnapshot => ({
      mode: "single-file",
      status: "idle",
      activeTab: "runner",
      isFullHeight,
    });

    function paused() {
      metadata.current = { ...metadata.current, isPlaying: false };
    }

    it("follows the recording until the viewer touches the toggle", () => {
      replaying(recorded(false));
      const { result } = renderLayout();
      expect(result.current.layout.displayIsFullHeight).toBe(false);

      act(() => result.current.store.trigger.setPlaybackSnapshot({ snapshot: recorded(true) }));
      expect(result.current.layout.displayIsFullHeight).toBe(true);

      act(() => result.current.store.trigger.setPlaybackSnapshot({ snapshot: recorded(false) }));
      expect(result.current.layout.displayIsFullHeight).toBe(false);
    });

    it("shows the viewer's toggle at once and keeps it over the recording's later changes", () => {
      replaying(recorded(false));
      const { result } = renderLayout();

      act(() => result.current.layout.toggleFullHeight());
      expect(result.current.layout.displayIsFullHeight).toBe(true);

      act(() => result.current.store.trigger.setPlaybackSnapshot({ snapshot: recorded(false) }));
      expect(result.current.layout.displayIsFullHeight).toBe(true);

      act(() => result.current.layout.toggleFullHeight());
      act(() => result.current.store.trigger.setPlaybackSnapshot({ snapshot: recorded(true) }));
      expect(result.current.layout.displayIsFullHeight).toBe(false);
    });

    it("leaves the live height, which recordings capture, alone", () => {
      replaying(recorded(false));
      const { result } = renderLayout();

      act(() => result.current.layout.toggleFullHeight());

      const context = result.current.store.getSnapshot().context;
      expect(selectViewerFullHeight(context)).toBe(true);
      expect(selectIsFullHeight(context)).toBe(false);
      expect(result.current.layout.isFullHeight).toBe(false);
    });

    it("keeps the viewer's height on screen when playback pauses or ends, and on resume", () => {
      replaying(recorded(true));
      const { result, rerender } = renderLayout();
      act(() => result.current.layout.toggleFullHeight());
      expect(result.current.layout.displayIsFullHeight).toBe(false);

      // The live height is full here, so falling back to it would jump.
      act(() => result.current.store.trigger.setIsFullHeight({ fullHeight: true }));
      paused();
      rerender();
      expect(result.current.layout.isPlaybackSnapshotActive).toBe(false);
      expect(result.current.layout.displayIsFullHeight).toBe(false);

      // Toggling while paused keeps changing the viewer's choice, not the live value.
      act(() => result.current.layout.toggleFullHeight());
      expect(result.current.layout.displayIsFullHeight).toBe(true);
      act(() => result.current.layout.toggleFullHeight());
      expect(result.current.layout.displayIsFullHeight).toBe(false);
      expect(selectIsFullHeight(result.current.store.getSnapshot().context)).toBe(true);

      replaying(recorded(true));
      rerender();
      expect(result.current.layout.displayIsFullHeight).toBe(false);
    });

    it("makes a first press while paused the viewer's choice, which survives resuming", () => {
      replaying(recorded(true));
      const { result, rerender } = renderLayout();
      paused();
      rerender();
      expect(result.current.layout.displayIsFullHeight).toBe(false);

      act(() => result.current.layout.toggleFullHeight());

      const context = result.current.store.getSnapshot().context;
      expect(result.current.layout.displayIsFullHeight).toBe(true);
      expect(selectViewerFullHeight(context)).toBe(true);
      expect(selectIsFullHeight(context)).toBe(false);

      // The recording is at full height too; switch it off to show the viewer's choice wins.
      replaying(recorded(false));
      rerender();
      expect(result.current.layout.displayIsFullHeight).toBe(true);
    });

    it("flips the live height when no replay is loaded", () => {
      const { result } = renderLayout();

      act(() => result.current.layout.toggleFullHeight());

      const context = result.current.store.getSnapshot().context;
      expect(selectIsFullHeight(context)).toBe(true);
      expect(selectViewerFullHeight(context)).toBeNull();
      expect(result.current.layout.displayIsFullHeight).toBe(true);
    });

    it("follows the recording again once the choice ends", () => {
      replaying(recorded(false));
      const { result } = renderLayout();
      act(() => result.current.layout.toggleFullHeight());
      expect(result.current.layout.displayIsFullHeight).toBe(true);

      act(() => result.current.store.trigger.clearViewerFullHeight());

      expect(result.current.layout.displayIsFullHeight).toBe(false);
      act(() => result.current.store.trigger.setPlaybackSnapshot({ snapshot: recorded(true) }));
      expect(result.current.layout.displayIsFullHeight).toBe(true);
    });

    it("shows and toggles the live height while a take is being recorded", () => {
      const { result, rerender } = renderLayout();
      act(() => result.current.store.trigger.setViewerFullHeight({ fullHeight: true }));
      metadata.current = {
        currentRecording: null,
        isPlaying: false,
        isRecording: true,
        isReplayLoaded: false,
      };
      rerender();
      expect(result.current.layout.displayIsFullHeight).toBe(false);

      act(() => result.current.layout.toggleFullHeight());

      const context = result.current.store.getSnapshot().context;
      expect(selectIsFullHeight(context)).toBe(true);
      expect(selectViewerFullHeight(context)).toBe(true);
      expect(result.current.layout.displayIsFullHeight).toBe(true);

      act(() => result.current.layout.toggleFullHeight());
      expect(selectIsFullHeight(result.current.store.getSnapshot().context)).toBe(false);
      expect(result.current.layout.displayIsFullHeight).toBe(false);
    });
  });
});
