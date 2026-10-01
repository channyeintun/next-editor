import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createWhiteboardStore, type WhiteboardStoreInstance } from "../stores/whiteboardStore";
import type { useCollaboration } from "./CollaborationContext";
import type { NextEditorActions } from "./NextEditorContext";

type CollaborationContextValue = ReturnType<typeof useCollaboration>;

const mocks = vi.hoisted(() => ({
  publishWhiteboardDelta: vi.fn<CollaborationContextValue["publishWhiteboardDelta"]>(),
  recordWhiteboardEvent: vi.fn<NextEditorActions["handleWhiteboardEvent"]>(),
}));

let whiteboardStore: WhiteboardStoreInstance;
let collaborationState: Record<string, unknown>;
let metadata: Record<string, unknown>;

vi.mock("./WhiteboardStoreContext", () => ({
  useWhiteboardStore: () => ({ store: whiteboardStore }),
}));
vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () => ({ handleWhiteboardEvent: mocks.recordWhiteboardEvent }),
  useNextEditorMetadata: () => metadata,
}));
vi.mock("./CollaborationContext", () => ({
  useOptionalCollaboration: () => collaborationState,
}));

import { WhiteboardProvider, useWhiteboardContext } from "./WhiteboardContext";

function element(id: string) {
  return { id, version: 1, versionNonce: 10, isDeleted: false, index: "a0" };
}

describe("WhiteboardContext live-room ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    whiteboardStore = createWhiteboardStore();
    metadata = { usesPlaybackModel: false };
    mocks.publishWhiteboardDelta.mockReturnValue(true);
    collaborationState = {
      provider: {},
      teaching: { initialized: true },
      publishWhiteboardDelta: mocks.publishWhiteboardDelta,
    };
  });

  afterEach(() => vi.useRealTimers());

  it("publishes content once through the canonical room path", () => {
    const { result } = renderHook(() => useWhiteboardContext(), {
      wrapper: WhiteboardProvider,
    });
    act(() => {
      result.current.handleExcalidrawChange(
        [element("stroke")],
        { scrollX: 0, scrollY: 0, zoom: 1 },
        false,
      );
      vi.advanceTimersByTime(100);
    });

    expect(mocks.publishWhiteboardDelta).toHaveBeenCalledWith({
      upserts: [element("stroke")],
    });
    expect(mocks.recordWhiteboardEvent).not.toHaveBeenCalled();
  });

  it("records followed view state separately without publishing content", () => {
    const { result } = renderHook(() => useWhiteboardContext(), {
      wrapper: WhiteboardProvider,
    });
    act(() => {
      result.current.applyView({ scrollX: 20, scrollY: -10, zoom: 2 }, true);
    });

    expect(mocks.publishWhiteboardDelta).not.toHaveBeenCalled();
    expect(mocks.recordWhiteboardEvent).toHaveBeenCalledWith({
      timestamp: expect.any(Number),
      view: { scrollX: 20, scrollY: -10, zoom: 2 },
      isMaximized: true,
    });
  });
});

describe("WhiteboardContext playback viewer view", () => {
  const recording = { id: "lesson-a" };
  const pinched = { scrollX: -80, scrollY: 30, zoom: 2 };

  beforeEach(() => {
    whiteboardStore = createWhiteboardStore();
    collaborationState = {};
  });

  it("keeps the viewer's view across pause and resume and releases it when playback stops", () => {
    metadata = { usesPlaybackModel: true, isInPlaybackSession: true, currentRecording: recording };
    const { rerender } = renderHook(() => useWhiteboardContext(), {
      wrapper: WhiteboardProvider,
    });
    act(() =>
      whiteboardStore.trigger.observePlaybackCanvasView({
        view: pinched,
        appliedView: { scrollX: 0, scrollY: 0, zoom: 1 },
      }),
    );

    // Paused or ended: the workspace is the viewer's (usesPlaybackModel false), the session
    // goes on.
    metadata = { usesPlaybackModel: false, isInPlaybackSession: true, currentRecording: recording };
    rerender();
    expect(whiteboardStore.getSnapshot().context.playbackViewerView).toEqual(pinched);

    metadata = { usesPlaybackModel: true, isInPlaybackSession: true, currentRecording: recording };
    rerender();
    expect(whiteboardStore.getSnapshot().context.playbackViewerView).toEqual(pinched);

    // STOP returns to the ready state, which is not a playback session.
    metadata = {
      usesPlaybackModel: false,
      isInPlaybackSession: false,
      currentRecording: recording,
    };
    rerender();
    expect(whiteboardStore.getSnapshot().context.playbackViewerView).toBeNull();
  });
});
