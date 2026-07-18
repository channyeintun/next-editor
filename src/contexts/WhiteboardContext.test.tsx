import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWhiteboardStore, type WhiteboardStoreInstance } from "../stores/whiteboardStore";

const mocks = vi.hoisted(() => ({
  publishWhiteboardDelta: vi.fn(),
  recordWhiteboardEvent: vi.fn(),
}));

let whiteboardStore: WhiteboardStoreInstance;
let collaborationState: Record<string, unknown>;

vi.mock("./WhiteboardStoreContext", () => ({
  useWhiteboardStore: () => ({ store: whiteboardStore }),
}));
vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () => ({ handleWhiteboardEvent: mocks.recordWhiteboardEvent }),
  useNextEditorMetadata: () => ({ usesPlaybackModel: false }),
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
