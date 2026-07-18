import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlidesStore, type SlidesStoreInstance } from "../stores/slidesStore";
import type { useCollaboration } from "./CollaborationContext";
import type { NextEditorActions } from "./NextEditorContext";

type CollaborationContextValue = ReturnType<typeof useCollaboration>;

const mocks = vi.hoisted(() => ({
  recordSlideEvent: vi.fn<NextEditorActions["handleSlideEvent"]>(),
  publishCurrentSlide: vi.fn<CollaborationContextValue["publishCurrentSlide"]>(),
}));

let slidesStore: SlidesStoreInstance;
let collaborationState: Record<string, unknown>;

vi.mock("./SlidesStoreContext", () => ({
  useSlidesStore: () => ({ store: slidesStore }),
}));
vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () => ({ handleSlideEvent: mocks.recordSlideEvent }),
}));
vi.mock("./CollaborationContext", () => ({
  useOptionalCollaboration: () => collaborationState,
}));

import { SlidesProvider, useSlidesContext } from "./SlidesContext";

function seedStore() {
  slidesStore = createSlidesStore();
  slidesStore.trigger.setSlides({
    slides: [
      { id: "one", order: 0, content: "one", contentType: "html" },
      { id: "two", order: 1, content: "two", contentType: "html" },
    ],
  });
  slidesStore.trigger.setPreviewState({
    previewState: {
      isOpen: false,
      isMaximized: false,
      currentSlideId: "one",
      indexv: 0,
    },
  });
}

describe("SlidesContext live-room ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedStore();
    mocks.publishCurrentSlide.mockReturnValue(true);
    collaborationState = {
      provider: {},
      teaching: { initialized: true, currentSlideId: "one" },
      publishCurrentSlide: mocks.publishCurrentSlide,
    };
  });

  it("routes a whole-slide change only through the canonical room path", () => {
    const { result } = renderHook(() => useSlidesContext(), { wrapper: SlidesProvider });
    act(() => {
      result.current.handleSlideEvent({
        type: "slide_change",
        timestamp: 1,
        slideId: "two",
        indexv: 0,
      });
    });

    expect(mocks.publishCurrentSlide).toHaveBeenCalledWith("two");
    expect(mocks.recordSlideEvent).not.toHaveBeenCalled();
    expect(slidesStore.getSnapshot().context.previewState.currentSlideId).toBe("two");
  });

  it("keeps build steps local and out of the room slide command", () => {
    const { result } = renderHook(() => useSlidesContext(), { wrapper: SlidesProvider });
    act(() => {
      result.current.handleSlideEvent({
        type: "slide_change",
        timestamp: 1,
        slideId: "one",
        indexv: 2,
      });
    });

    expect(mocks.publishCurrentSlide).not.toHaveBeenCalled();
    expect(mocks.recordSlideEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "slide_change", slideId: "one", indexv: 2 }),
    );
    expect(slidesStore.getSnapshot().context.previewState.indexv).toBe(2);
  });

  it("does not let a rejected viewer command diverge the local shared slide", () => {
    mocks.publishCurrentSlide.mockReturnValue(false);
    const { result } = renderHook(() => useSlidesContext(), { wrapper: SlidesProvider });
    act(() => {
      result.current.handleSlideEvent({
        type: "slide_change",
        timestamp: 1,
        slideId: "two",
        indexv: 0,
      });
    });

    expect(mocks.publishCurrentSlide).toHaveBeenCalledWith("two");
    expect(slidesStore.getSnapshot().context.previewState.currentSlideId).toBe("one");
  });

  it("records local visibility separately and retains the room slide on close", () => {
    const { result } = renderHook(() => useSlidesContext(), { wrapper: SlidesProvider });
    act(() => {
      result.current.handleSlideEvent({
        type: "slide_open",
        timestamp: 1,
        slideId: "one",
        isMaximized: true,
        indexv: 0,
      });
    });
    act(() => {
      result.current.closePresentation();
    });

    expect(mocks.publishCurrentSlide).not.toHaveBeenCalled();
    expect(mocks.recordSlideEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "slide_close", slideId: "one" }),
    );
    expect(slidesStore.getSnapshot().context.previewState).toMatchObject({
      isOpen: false,
      currentSlideId: "one",
    });
  });

  it("reopens a room slide at baseline instead of restoring a remembered build step", () => {
    const { result } = renderHook(() => useSlidesContext(), { wrapper: SlidesProvider });
    act(() => {
      result.current.handleSlideEvent({
        type: "slide_change",
        timestamp: 1,
        slideId: "one",
        indexv: 2,
      });
      result.current.closePresentation();
      result.current.openPresentation();
    });

    expect(slidesStore.getSnapshot().context.previewState).toMatchObject({
      isOpen: true,
      currentSlideId: "one",
      indexv: 0,
    });
    expect(mocks.recordSlideEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "slide_open", slideId: "one", indexv: 0 }),
    );
  });

  it("keeps standalone presentation memory isolated across a room scope", () => {
    collaborationState = {};
    const { result, rerender } = renderHook(() => useSlidesContext(), {
      wrapper: SlidesProvider,
    });
    act(() => {
      result.current.handleSlideEvent({
        type: "slide_change",
        timestamp: 1,
        slideId: "one",
        indexv: 2,
      });
    });
    act(() => result.current.closePresentation());

    collaborationState = {
      provider: {},
      teaching: { initialized: true, currentSlideId: "two" },
      publishCurrentSlide: mocks.publishCurrentSlide,
    };
    act(() => {
      slidesStore.trigger.setPreviewState({
        previewState: {
          isOpen: false,
          isMaximized: false,
          currentSlideId: "two",
          indexv: 0,
        },
      });
      rerender();
    });
    act(() => result.current.openPresentation());
    expect(slidesStore.getSnapshot().context.previewState).toMatchObject({
      currentSlideId: "two",
      indexv: 0,
    });

    collaborationState = {};
    act(() => {
      slidesStore.trigger.setPreviewState({
        previewState: {
          isOpen: false,
          isMaximized: false,
          currentSlideId: null,
          indexv: 0,
        },
      });
      rerender();
    });
    act(() => result.current.openPresentation());
    expect(slidesStore.getSnapshot().context.previewState).toMatchObject({
      currentSlideId: "one",
      indexv: 2,
    });
  });
});
