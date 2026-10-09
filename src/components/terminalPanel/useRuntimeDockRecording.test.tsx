import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../../core/src/types";
import { createRuntimePanelStore, selectPlaybackSnapshot } from "../../stores/runtimePanelStore";
import type { RuntimeRecordingSnapshot } from "../../types/runtime";
import { useRuntimeDockRecording } from "./useRuntimeDockRecording";

interface DockState {
  activeTab: string;
  consoleLines: string[];
}

interface Props {
  state: DockState;
  isRecording: boolean;
  isPlaybackSnapshotActive: boolean;
  currentRecording: Recording | null;
}

const recording = { id: "take" } as Recording;
const snapshot: RuntimeRecordingSnapshot = { mode: "single-file", status: "idle" };

function renderRecording(initial: Partial<Props> = {}) {
  const handleRuntimeEvent = vi.fn<() => void>();
  const runtimePanelStore = createRuntimePanelStore();
  const initialProps: Props = {
    state: { activeTab: "runner", consoleLines: [] },
    isRecording: true,
    isPlaybackSnapshotActive: false,
    currentRecording: recording,
    ...initial,
  };
  const view = renderHook(
    ({ state, ...options }: Props) =>
      useRuntimeDockRecording(state, { ...options, handleRuntimeEvent, runtimePanelStore }),
    { initialProps },
  );
  return { ...view, handleRuntimeEvent, runtimePanelStore, initialProps };
}

describe("useRuntimeDockRecording", () => {
  it("sends nothing while no take is recorded", () => {
    const { rerender, handleRuntimeEvent, initialProps } = renderRecording({ isRecording: false });

    rerender({ ...initialProps, state: { activeTab: "console", consoleLines: ["ready"] } });

    expect(handleRuntimeEvent).not.toHaveBeenCalled();
  });

  it("sends one event per structural change while recording, and none for the first state", () => {
    const { rerender, handleRuntimeEvent, initialProps } = renderRecording();
    expect(handleRuntimeEvent).not.toHaveBeenCalled();

    rerender({ ...initialProps, state: { activeTab: "console", consoleLines: [] } });
    expect(handleRuntimeEvent).toHaveBeenCalledTimes(1);

    rerender({ ...initialProps, state: { activeTab: "console", consoleLines: ["ready"] } });
    expect(handleRuntimeEvent).toHaveBeenCalledTimes(2);
  });

  it("sends nothing for a new object that is structurally equal", () => {
    const { rerender, handleRuntimeEvent, initialProps } = renderRecording();

    rerender({ ...initialProps, state: { activeTab: "runner", consoleLines: [] } });

    expect(handleRuntimeEvent).not.toHaveBeenCalled();
  });

  it("sends nothing while a replay is on screen, and resumes from the state it left", () => {
    const { rerender, handleRuntimeEvent, initialProps } = renderRecording({
      isPlaybackSnapshotActive: true,
    });

    rerender({ ...initialProps, state: { activeTab: "agent", consoleLines: [] } });
    expect(handleRuntimeEvent).not.toHaveBeenCalled();

    rerender({
      ...initialProps,
      isPlaybackSnapshotActive: false,
      state: { activeTab: "agent", consoleLines: [] },
    });
    expect(handleRuntimeEvent).not.toHaveBeenCalled();

    rerender({
      ...initialProps,
      isPlaybackSnapshotActive: false,
      state: { activeTab: "runner", consoleLines: [] },
    });
    expect(handleRuntimeEvent).toHaveBeenCalledTimes(1);
  });

  it("clears the playback snapshot once no recording is loaded", () => {
    const { rerender, runtimePanelStore, initialProps } = renderRecording();
    runtimePanelStore.trigger.setPlaybackSnapshot({ snapshot });

    rerender({ ...initialProps });
    expect(selectPlaybackSnapshot(runtimePanelStore.getSnapshot().context)).toBe(snapshot);

    rerender({ ...initialProps, currentRecording: null });
    expect(selectPlaybackSnapshot(runtimePanelStore.getSnapshot().context)).toBeNull();
  });
});
