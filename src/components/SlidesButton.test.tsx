import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { useCollaboration } from "../contexts/CollaborationContext";
import type { NextEditorActions } from "../contexts/NextEditorContext";
import type { useSlidesContext } from "../contexts/SlidesContext";
import type { useWhiteboardContext } from "../contexts/WhiteboardContext";
import { selectMetadata, type MetadataSelector } from "../test/selectMetadata";

type CollaborationContextValue = ReturnType<typeof useCollaboration>;
type SlidesContextValue = ReturnType<typeof useSlidesContext>;
type WhiteboardContextValue = ReturnType<typeof useWhiteboardContext>;

const mocks = vi.hoisted(() => ({
  closePresentation: vi.fn<SlidesContextValue["closePresentation"]>(),
  openPresentation: vi.fn<SlidesContextValue["openPresentation"]>(),
  pause: vi.fn<NextEditorActions["pause"]>(),
  setWhiteboardOpen: vi.fn<WhiteboardContextValue["setOpen"]>(),
  stopFollowing: vi.fn<CollaborationContextValue["stopFollowing"]>(),
}));

let collaborationState: Record<string, unknown> | null;
let slidesState: Record<string, unknown>;
let whiteboardOpen = false;

vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () => ({ pause: mocks.pause }),
  useNextEditorMetadata: (select?: MetadataSelector) =>
    selectMetadata({ isRecording: false, isPlaying: false, usesPlaybackModel: false }, select),
}));
vi.mock("../contexts/SlidesContext", () => ({
  useSlidesContext: () => slidesState,
}));
vi.mock("../contexts/CollaborationContext", () => ({
  useOptionalCollaboration: () => collaborationState,
}));
vi.mock("../contexts/WhiteboardContext", () => ({
  useWhiteboardContext: () => ({ isOpen: whiteboardOpen, setOpen: mocks.setWhiteboardOpen }),
}));
vi.mock("./SlidesManager", () => ({
  default: ({ onStartPresentation }: { onStartPresentation: () => void }) => (
    <div role="dialog" aria-label="Slide manager">
      <button type="button" onClick={onStartPresentation}>
        Start presentation
      </button>
    </div>
  ),
}));

import SlidesButton from "./SlidesButton";

function resetState() {
  collaborationState = null;
  whiteboardOpen = false;
  slidesState = {
    slides: [{ id: "one", order: 0, content: "one", contentType: "html" }],
    previewState: { isOpen: false, isMaximized: false, currentSlideId: "one", indexv: 0 },
    setSlides: vi.fn<SlidesContextValue["setSlides"]>(),
    openPresentation: mocks.openPresentation,
    startPresentation: vi.fn<SlidesContextValue["startPresentation"]>(),
    closePresentation: mocks.closePresentation,
  };
}

describe("SlidesButton room presentation mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("closes the manager as soon as room creation starts and becomes a follow-stopping presentation toggle", async () => {
    const view = render(<SlidesButton />);
    const manage = screen.getByRole("button", { name: "Manage presentation slides" });
    expect(manage).toHaveAttribute("aria-expanded", "false");
    expect(manage).not.toHaveAttribute("aria-pressed");
    fireEvent.click(manage);
    expect(manage).toHaveAttribute("aria-expanded", "true");
    // The manager loads on first open.
    const manager = await screen.findByRole("dialog", { name: "Slide manager" });
    expect(document.getElementById(manage.getAttribute("aria-controls")!)).toContainElement(
      manager,
    );

    collaborationState = {
      provider: null,
      isCreatingRoom: true,
      stopFollowing: mocks.stopFollowing,
    };
    whiteboardOpen = true;
    view.rerender(<SlidesButton />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Slide manager" })).toBeNull());

    const toggle = screen.getByRole("button", { name: "Slides" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).not.toHaveAttribute("aria-expanded");
    expect(toggle).toHaveAttribute("title", "Show slides");
    fireEvent.click(toggle);
    expect(mocks.stopFollowing).toHaveBeenCalledWith("local-surface-change");
    expect(mocks.setWhiteboardOpen).toHaveBeenCalledWith(false);
    expect(mocks.openPresentation).toHaveBeenCalledTimes(1);
  });

  it("keeps the toggle's name constant and reports the shown deck as pressed", () => {
    slidesState = {
      ...slidesState,
      previewState: { isOpen: true, isMaximized: true, currentSlideId: "one", indexv: 0 },
    };
    render(<SlidesButton presentationToggleOnly />);

    const toggle = screen.getByRole("button", { name: "Slides", pressed: true });
    expect(toggle).toHaveAttribute("title", "Hide slides");
    fireEvent.click(toggle);
    expect(mocks.closePresentation).toHaveBeenCalledTimes(1);
  });

  it("does not expose the manager or an import path for an empty room deck", () => {
    collaborationState = { provider: {}, stopFollowing: mocks.stopFollowing };
    slidesState = { ...slidesState, slides: [] };
    const { container } = render(<SlidesButton />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("SlidesButton focus on a user open", () => {
  let frames: FrameRequestCallback[];
  const flushFrames = () => frames.splice(0).forEach((frame) => frame(performance.now()));

  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Stands in for the overlay's Close button, which SlidePreview renders.
  const overlayClose = (
    <button type="button" data-slides-initial-focus>
      Close slides
    </button>
  );

  it("moves focus into the presentation after the Slides toggle opens it", () => {
    render(
      <>
        <SlidesButton presentationToggleOnly />
        {overlayClose}
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Slides" }));
    expect(mocks.openPresentation).toHaveBeenCalledTimes(1);
    flushFrames();

    expect(screen.getByRole("button", { name: "Close slides" })).toHaveFocus();
  });

  it("moves focus into the presentation after starting it from the manager", async () => {
    render(
      <>
        <SlidesButton />
        {overlayClose}
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Manage presentation slides/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Start presentation" }));
    expect(slidesState.startPresentation).toHaveBeenCalledTimes(1);
    flushFrames();

    expect(screen.getByRole("button", { name: "Close slides" })).toHaveFocus();
  });
});
