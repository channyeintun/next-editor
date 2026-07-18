import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  closePresentation: vi.fn(),
  openPresentation: vi.fn(),
  pause: vi.fn(),
  setWhiteboardOpen: vi.fn(),
  stopFollowing: vi.fn(),
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
    setSlides: vi.fn(),
    openPresentation: mocks.openPresentation,
    startPresentation: vi.fn(),
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
