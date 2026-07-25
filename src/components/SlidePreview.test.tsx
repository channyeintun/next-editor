import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useCollaboration } from "../contexts/CollaborationContext";
import type { Slide, SlideEvent } from "../types/slides";

type CollaborationContextValue = ReturnType<typeof useCollaboration>;

const stopFollowing = vi.fn<CollaborationContextValue["stopFollowing"]>();
const retryAssets = vi.fn<CollaborationContextValue["retryAssets"]>();

vi.mock("../contexts/CollaborationContext", () => ({
  useOptionalCollaboration: () => ({
    provider: {},
    stopFollowing,
    retryAssets,
    isTeachingLoading: false,
    canRetryAssets: true,
  }),
}));
vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorMetadata: () => ({ isPlaying: false }),
}));
vi.mock("./CustomSlideRenderer", () => ({
  default: () => <div data-testid="slide-renderer" />,
}));

import SlidePreview from "./SlidePreview";

const slides: Slide[] = [
  { id: "one", order: 0, content: "one", contentType: "html" },
  { id: "two", order: 1, content: "two", contentType: "html" },
];

describe("SlidePreview local follow intent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it("stops following before minimizing and records only local view state", () => {
    const onSlideEvent = vi.fn<(event: SlideEvent) => boolean | void>();
    const onStopPlayback = vi.fn<() => void>();
    render(
      <SlidePreview
        slides={slides}
        currentSlideIndex={0}
        isOpen
        onSlideEvent={onSlideEvent}
        onStopPlayback={onStopPlayback}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Minimize slides" }));
    expect(stopFollowing).toHaveBeenCalledWith("local-slide-input");
    expect(onSlideEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "slide_minimize", slideId: "one", isMaximized: false }),
    );
    expect(stopFollowing.mock.invocationCallOrder[0]).toBeLessThan(
      onSlideEvent.mock.invocationCallOrder[0],
    );
    expect(onStopPlayback).toHaveBeenCalledTimes(1);
  });

  it("stops following before whole-slide arrows, close, and backdrop actions", () => {
    const onSlideEvent = vi.fn<(event: SlideEvent) => boolean | void>();
    const onClose = vi.fn<() => void>();
    const view = render(
      <SlidePreview
        slides={slides}
        currentSlideIndex={0}
        isOpen
        onSlideEvent={onSlideEvent}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(stopFollowing).toHaveBeenCalledWith("local-slide-input");
    expect(onSlideEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "slide_change", slideId: "two", indexv: 0 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Close slides" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(view.container.firstElementChild!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps iframe interaction local while stopping follow first", () => {
    const onSlideEvent = vi.fn<(event: SlideEvent) => boolean | void>();
    render(
      <SlidePreview slides={slides} currentSlideIndex={0} isOpen onSlideEvent={onSlideEvent} />,
    );

    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        data: {
          type: "IFRAME_INTERACTION",
          payload: {
            type: "click",
            target: { tagName: "BUTTON", xpath: "/html/body/button" },
            data: { clientX: 10, clientY: 20 },
          },
        },
      }),
    );

    expect(stopFollowing).toHaveBeenCalledWith("local-slide-input");
    expect(onSlideEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "slide_interaction",
        slideId: "one",
        interaction: expect.objectContaining({ type: "click" }),
      }),
    );
  });

  it("ignores interaction messages from a foreign origin or a malformed payload", () => {
    stopFollowing.mockClear();
    const onSlideEvent = vi.fn<(event: SlideEvent) => boolean | void>();
    render(
      <SlidePreview slides={slides} currentSlideIndex={0} isOpen onSlideEvent={onSlideEvent} />,
    );

    // A page framing the app, or window.opener, must not be able to cancel
    // follow-mode or forge events into a live recording.
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: "https://evil.example",
        data: { type: "IFRAME_INTERACTION", payload: { type: "click" } },
      }),
    );
    // A missing payload used to throw a TypeError inside the listener.
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        data: { type: "IFRAME_INTERACTION" },
      }),
    );

    expect(stopFollowing).not.toHaveBeenCalled();
    expect(onSlideEvent).not.toHaveBeenCalled();
  });

  it("shows an unavailable room slide without falling back and offers asset retry", () => {
    render(<SlidePreview slides={[]} currentSlideIndex={-1} isOpen />);

    expect(screen.getByRole("status")).toHaveTextContent("Shared slide unavailable");
    expect(screen.queryByTestId("slide-renderer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryAssets).toHaveBeenCalledTimes(1);
  });
});
