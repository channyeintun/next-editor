import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { useCollaboration } from "../contexts/CollaborationContext";
import type { Slide, SlideEvent } from "../types/slides";

type CollaborationContextValue = ReturnType<typeof useCollaboration>;

const stopFollowing = vi.fn<CollaborationContextValue["stopFollowing"]>();
const retryAssets = vi.fn<CollaborationContextValue["retryAssets"]>();
let isPlaying = false;

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
  useNextEditorMetadata: () => ({ isPlaying }),
}));
vi.mock("./CustomSlideRenderer", () => ({
  default: () => (
    <div data-testid="slide-renderer">
      <iframe title="Slide frame" />
    </div>
  ),
}));

import SlidePreview from "./SlidePreview";

function slideFrameWindow(): Window {
  const frame = screen.getByTitle<HTMLIFrameElement>("Slide frame");
  return frame.contentWindow!;
}

const slides: Slide[] = [
  { id: "one", order: 0, content: "one", contentType: "html" },
  { id: "two", order: 1, content: "two", contentType: "html" },
];

describe("SlidePreview local follow intent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    isPlaying = false;
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
        source: slideFrameWindow(),
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

  it("ignores interaction messages from a frame that is not a slide", () => {
    const onSlideEvent = vi.fn<(event: SlideEvent) => boolean | void>();
    render(
      <SlidePreview slides={slides} currentSlideIndex={0} isOpen onSlideEvent={onSlideEvent} />,
    );
    // The code preview runs the same capture script in a same-origin frame.
    const preview = document.createElement("iframe");
    document.body.append(preview);

    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        source: preview.contentWindow,
        data: {
          type: "IFRAME_INTERACTION",
          payload: { type: "hover_start", target: { tagName: "DIV", xpath: "/html/body/div" } },
        },
      }),
    );
    preview.remove();

    expect(stopFollowing).not.toHaveBeenCalled();
    expect(onSlideEvent).not.toHaveBeenCalled();
  });

  it("ignores slide frame interaction while the deck is closed", () => {
    const onSlideEvent = vi.fn<(event: SlideEvent) => boolean | void>();
    const view = render(
      <SlidePreview slides={slides} currentSlideIndex={0} isOpen onSlideEvent={onSlideEvent} />,
    );
    const source = slideFrameWindow();
    view.rerender(
      <SlidePreview
        slides={slides}
        currentSlideIndex={0}
        isOpen={false}
        onSlideEvent={onSlideEvent}
      />,
    );

    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        source,
        data: { type: "IFRAME_INTERACTION", payload: { type: "click" } },
      }),
    );

    expect(onSlideEvent).not.toHaveBeenCalled();
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
        source: slideFrameWindow(),
        data: { type: "IFRAME_INTERACTION", payload: { type: "click" } },
      }),
    );
    // A missing payload used to throw a TypeError inside the listener.
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        source: slideFrameWindow(),
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

describe("SlidePreview focus and keys", () => {
  let frames: FrameRequestCallback[];
  const flushFrames = () => frames.splice(0).forEach((frame) => frame(performance.now()));

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    isPlaying = false;
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a named, non-modal region so the media controls above it stay reachable", () => {
    render(<SlidePreview slides={slides} currentSlideIndex={0} isOpen />);

    expect(screen.getByRole("region", { name: "Presentation slides" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["Close slides", "Minimize slides"])(
    "returns focus to the Slides button after %s",
    (name) => {
      const view = render(
        <>
          <button type="button" data-tour="slides">
            Slides
          </button>
          <SlidePreview
            slides={slides}
            currentSlideIndex={0}
            isOpen
            onClose={() => {}}
            onSlideEvent={() => {}}
          />
        </>,
      );
      const control = screen.getByRole("button", { name });
      control.focus();
      fireEvent.click(control);
      view.rerender(
        <>
          <button type="button" data-tour="slides">
            Slides
          </button>
          <SlidePreview slides={slides} currentSlideIndex={0} isOpen={false} />
        </>,
      );
      flushFrames();

      expect(screen.getByRole("button", { name: "Slides" })).toHaveFocus();
    },
  );

  it("leaves focus alone when Escape closes the deck from outside it", () => {
    const onClose = vi.fn<() => void>();
    render(
      <>
        <button type="button" data-tour="slides">
          Slides
        </button>
        <button type="button">Play</button>
        <SlidePreview slides={slides} currentSlideIndex={0} isOpen onClose={onClose} />
      </>,
    );
    const play = screen.getByRole("button", { name: "Play" });
    play.focus();
    fireEvent.keyDown(play, { key: "Escape" });
    flushFrames();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(play).toHaveFocus();
  });

  it("marks the Close button as where a user open puts focus", () => {
    render(<SlidePreview slides={slides} currentSlideIndex={0} isOpen />);

    expect(screen.getByRole("button", { name: "Close slides" })).toHaveAttribute(
      "data-slides-initial-focus",
    );
  });

  it("takes the arrow keys for slide navigation while paused", () => {
    const onSlideEvent = vi.fn<(event: SlideEvent) => boolean | void>();
    render(
      <SlidePreview slides={slides} currentSlideIndex={0} isOpen onSlideEvent={onSlideEvent} />,
    );

    expect(fireEvent.keyDown(document.body, { key: "ArrowRight" })).toBe(false);
    expect(onSlideEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "slide_change", slideId: "two" }),
    );
  });

  it("leaves the arrow keys to the player's seek keys during playback", () => {
    isPlaying = true;
    const onSlideEvent = vi.fn<(event: SlideEvent) => boolean | void>();
    render(
      <SlidePreview slides={slides} currentSlideIndex={1} isOpen onSlideEvent={onSlideEvent} />,
    );

    expect(fireEvent.keyDown(document.body, { key: "ArrowLeft" })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "ArrowRight" })).toBe(true);
    expect(onSlideEvent).not.toHaveBeenCalled();
  });

  it("leaves the arrow keys to a focused slider or field", () => {
    const onSlideEvent = vi.fn<(event: SlideEvent) => boolean | void>();
    render(
      <>
        <input type="range" aria-label="Volume" />
        <input type="text" aria-label="Message" />
        <SlidePreview slides={slides} currentSlideIndex={0} isOpen onSlideEvent={onSlideEvent} />
      </>,
    );

    expect(fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" })).toBe(true);
    expect(fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowLeft" })).toBe(true);
    expect(onSlideEvent).not.toHaveBeenCalled();
  });
});

describe("SlidePreview slide counter", () => {
  /** The counter's text as a screen reader reads it (aria-hidden parts left out). */
  const spokenText = (element: Element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll("[aria-hidden='true']").forEach((node) => node.remove());
    return copy.textContent?.replace(/\s+/g, " ").trim();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    isPlaying = false;
  });

  it("announces the slide position politely when the user moves", () => {
    const { container } = render(<SlidePreview slides={slides} currentSlideIndex={0} isOpen />);

    const counter = container.querySelector("[aria-live]")!;
    expect(counter).toHaveAttribute("aria-live", "polite");
    expect(counter).toHaveAttribute("aria-atomic", "true");
    expect(spokenText(counter)).toBe("Slide 1 of 2");
  });

  it("keeps quiet during playback so it never talks over the narration", () => {
    isPlaying = true;
    const { container } = render(<SlidePreview slides={slides} currentSlideIndex={1} isOpen />);

    const counter = container.querySelector("[aria-live]")!;
    expect(counter).toHaveAttribute("aria-live", "off");
    expect(spokenText(counter)).toBe("Slide 2 of 2");
  });
});
