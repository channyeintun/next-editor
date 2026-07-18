import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useCollaboration } from "../contexts/CollaborationContext";
import type { NextEditorActions } from "../contexts/NextEditorContext";
import type { useSlidesContext } from "../contexts/SlidesContext";
import type { useWhiteboardContext } from "../contexts/WhiteboardContext";

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
  useNextEditorMetadata: () => ({
    isRecording: false,
    isPlaying: false,
    usesPlaybackModel: false,
  }),
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
  default: () => <div role="dialog" aria-label="Slide manager" />,
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
    fireEvent.click(screen.getByRole("button", { name: /Manage presentation slides/i }));
    expect(screen.getByRole("dialog", { name: "Slide manager" })).toBeInTheDocument();

    collaborationState = {
      provider: null,
      isCreatingRoom: true,
      stopFollowing: mocks.stopFollowing,
    };
    whiteboardOpen = true;
    view.rerender(<SlidesButton />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Slide manager" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /Show slides/i }));
    expect(mocks.stopFollowing).toHaveBeenCalledWith("local-surface-change");
    expect(mocks.setWhiteboardOpen).toHaveBeenCalledWith(false);
    expect(mocks.openPresentation).toHaveBeenCalledTimes(1);
  });

  it("does not expose the manager or an import path for an empty room deck", () => {
    collaborationState = { provider: {}, stopFollowing: mocks.stopFollowing };
    slidesState = { ...slidesState, slides: [] };
    const { container } = render(<SlidesButton />);
    expect(container).toBeEmptyDOMElement();
  });
});
