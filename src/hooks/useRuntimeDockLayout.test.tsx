import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeRecordingSnapshot } from "../types/runtime";

const metadata = vi.hoisted(() => ({
  current: { currentRecording: null as unknown, isPlaying: false, isRecording: false },
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
  metadata.current = { currentRecording: { runtimeSnapshot }, isPlaying: true, isRecording: false };
}

describe("useRuntimeDockLayout", () => {
  beforeEach(() => {
    metadata.current = { currentRecording: null, isPlaying: false, isRecording: false };
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
    };

    const { result } = renderLayout();

    expect(result.current.layout).toMatchObject({
      isPlaybackSnapshotActive: false,
      recordedRuntimeSnapshot: null,
      displayActiveTab: "runner",
    });
  });
});
