import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhiteboardEvent } from "../core/src/whiteboard";
import { createWhiteboardStore } from "../stores/whiteboardStore";
import {
  discardPendingWhiteboardChange,
  flushPendingWhiteboardChange,
  useWhiteboardController,
} from "./useWhiteboardController";

function element(id: string, version = 1) {
  return {
    id,
    version,
    versionNonce: version * 10,
    isDeleted: false,
    index: id === "remote" ? "a1" : "a0",
  };
}

describe("useWhiteboardController", () => {
  afterEach(() => vi.useRealTimers());

  it("flushes pending visible changes synchronously at a room boundary", () => {
    vi.useFakeTimers();
    const store = createWhiteboardStore();
    const onWhiteboardEvent = vi.fn<(event: WhiteboardEvent) => boolean | void>();
    const { result } = renderHook(() => useWhiteboardController({ store, onWhiteboardEvent }));

    act(() => {
      result.current.handleExcalidrawChange(
        [element("boundary")],
        { scrollX: 3, scrollY: 4, zoom: 1.25 },
        false,
      );
      flushPendingWhiteboardChange(store);
    });

    expect(onWhiteboardEvent).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().context.scene).toMatchObject({
      elements: [expect.objectContaining({ id: "boundary" })],
      view: { scrollX: 3, scrollY: 4, zoom: 1.25 },
    });
    vi.advanceTimersByTime(100);
    expect(onWhiteboardEvent).toHaveBeenCalledTimes(1);
  });

  it("discards a pending delta when its room or playback scope is replaced", () => {
    vi.useFakeTimers();
    const store = createWhiteboardStore();
    const onWhiteboardEvent = vi.fn<(event: WhiteboardEvent) => boolean | void>();
    const { result, rerender } = renderHook(
      ({ scopeKey }) => useWhiteboardController({ store, onWhiteboardEvent, scopeKey }),
      { initialProps: { scopeKey: "standalone" } },
    );

    act(() => {
      result.current.handleExcalidrawChange(
        [element("stale")],
        { scrollX: 0, scrollY: 0, zoom: 1 },
        false,
      );
    });
    act(() => {
      rerender({ scopeKey: "room" });
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onWhiteboardEvent).not.toHaveBeenCalled();
    expect(store.getSnapshot().context.scene.elements).toEqual([]);

    act(() => {
      result.current.handleExcalidrawChange(
        [element("discarded")],
        { scrollX: 0, scrollY: 0, zoom: 1 },
        false,
      );
      discardPendingWhiteboardChange(store);
      vi.advanceTimersByTime(100);
    });
    expect(onWhiteboardEvent).not.toHaveBeenCalled();
  });

  it("applies and records local maximize state without changing board content", () => {
    const store = createWhiteboardStore();
    const onWhiteboardEvent = vi.fn<(event: WhiteboardEvent) => boolean | void>();
    const { result } = renderHook(() => useWhiteboardController({ store, onWhiteboardEvent }));
    const elements = store.getSnapshot().context.scene.elements;

    act(() => result.current.setMaximized(true));

    expect(store.getSnapshot().context.scene).toMatchObject({
      elements,
      isMaximized: true,
    });
    expect(store.getSnapshot().context.scene.elements).toBe(elements);
    expect(onWhiteboardEvent).toHaveBeenCalledWith({
      timestamp: expect.any(Number),
      isMaximized: true,
    });
  });

  it("clones mutable local upserts before recording and store projection", () => {
    vi.useFakeTimers();
    const store = createWhiteboardStore();
    const onWhiteboardEvent = vi.fn<(event: WhiteboardEvent) => boolean | void>();
    const { result } = renderHook(() => useWhiteboardController({ store, onWhiteboardEvent }));
    const live = { ...element("stroke"), points: [[0, 0]] };

    act(() => {
      result.current.handleExcalidrawChange([live], { scrollX: 0, scrollY: 0, zoom: 1 }, false);
      vi.advanceTimersByTime(100);
    });
    live.points.push([1, 1]);

    const event = onWhiteboardEvent.mock.calls[0]?.[0];
    expect(event.upserts?.[0]?.points).toEqual([[0, 0]]);
    expect(store.getSnapshot().context.scene.elements[0]).not.toBe(live);
  });

  it("rebases a pending local stroke over a remote element that arrived during capture", () => {
    vi.useFakeTimers();
    const store = createWhiteboardStore();
    store.trigger.setScene({
      scene: {
        ...store.getSnapshot().context.scene,
        elements: [element("local")],
      },
    });
    const { result } = renderHook(() => useWhiteboardController({ store }));

    act(() => {
      result.current.handleExcalidrawChange(
        [element("local", 2)],
        { scrollX: 0, scrollY: 0, zoom: 1 },
        false,
      );
      store.trigger.setScene({
        scene: {
          ...store.getSnapshot().context.scene,
          elements: [element("local"), element("remote")],
        },
      });
      vi.advanceTimersByTime(100);
    });

    expect(store.getSnapshot().context.scene.elements.map(({ id }) => id)).toEqual([
      "local",
      "remote",
    ]);
    expect(store.getSnapshot().context.scene.elements[0]?.version).toBe(2);
  });

  it("keeps viewer content read-only while retaining local pan and zoom", () => {
    vi.useFakeTimers();
    const store = createWhiteboardStore();
    store.trigger.setScene({
      scene: { ...store.getSnapshot().context.scene, elements: [element("shared")] },
    });
    const onWhiteboardEvent = vi.fn<(event: WhiteboardEvent) => boolean | void>();
    const { result } = renderHook(() => useWhiteboardController({ store, onWhiteboardEvent }));

    act(() => {
      result.current.handleExcalidrawChange(
        [element("malicious-local")],
        { scrollX: 25, scrollY: -10, zoom: 2 },
        true,
      );
      vi.advanceTimersByTime(100);
    });

    expect(store.getSnapshot().context.scene).toMatchObject({
      elements: [expect.objectContaining({ id: "shared" })],
      view: { scrollX: 25, scrollY: -10, zoom: 2 },
    });
    expect(onWhiteboardEvent).toHaveBeenCalledWith({
      timestamp: expect.any(Number),
      view: { scrollX: 25, scrollY: -10, zoom: 2 },
    });
  });

  it("rolls back a local content delta rejected by the collaboration boundary", () => {
    vi.useFakeTimers();
    const store = createWhiteboardStore();
    store.trigger.setScene({
      scene: { ...store.getSnapshot().context.scene, elements: [element("shared")] },
    });
    const { result } = renderHook(() =>
      useWhiteboardController({ store, onWhiteboardEvent: () => false }),
    );

    act(() => {
      result.current.handleExcalidrawChange(
        [element("local")],
        { scrollX: 0, scrollY: 0, zoom: 1 },
        false,
      );
      vi.advanceTimersByTime(100);
    });

    expect(store.getSnapshot().context.scene.elements).toEqual([element("shared")]);
  });
});
