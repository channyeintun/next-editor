import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import CameraOverlay from "./CameraOverlay";
import { cameraOverlayStore } from "../stores/cameraOverlayStore";

// A recording whose camera streams from a hosted video, so the overlay shows without a camera
// blob or the live preview.
const editor = vi.hoisted(() => ({
  actor: {},
  snapshot: { context: { recording: { cameraUrl: "https://cdn.example.com/camera.webm" } } },
}));

vi.mock("../contexts/NextEditorActorContext", () => ({
  NextEditorActorContext: {
    useActorRef: () => editor.actor,
    useSelector: (selector: (snapshot: unknown) => unknown) => selector(editor.snapshot),
  },
}));

// The timeline drives the <video>; the controls under test do not depend on it.
vi.mock("./cameraOverlay/useTimelineSyncedVideo", () => ({
  useTimelineSyncedVideo: () => {},
}));

beforeEach(() => {
  window.localStorage.clear();
  cameraOverlayStore.trigger.setMinimized({ minimized: false });
});

afterEach(() => {
  cameraOverlayStore.trigger.setMinimized({ minimized: false });
  window.localStorage.clear();
});

describe("CameraOverlay", () => {
  it("reveals the minimize control on keyboard focus and on touch screens, not only on hover", () => {
    render(<CameraOverlay />);

    const minimize = screen.getByRole("button", { name: "Minimize camera" });
    expect(minimize).toHaveClass(
      "opacity-0",
      "group-hover:opacity-100",
      "focus-visible:opacity-100",
      "pointer-coarse:opacity-100",
    );
  });

  it("moves to the next corner with a click instead of a drag, keeping focus on the button", () => {
    render(<CameraOverlay />);

    const move = screen.getByRole("button", { name: "Move camera to next corner" });
    expect(move).toHaveClass(
      "opacity-0",
      "group-hover:opacity-100",
      "focus-visible:opacity-100",
      "pointer-coarse:opacity-100",
    );
    const overlay = move.parentElement as HTMLElement;
    // jsdom's window is 1024 × 768; the overlay starts above the player bar's right end.
    expect(overlay.style.transform).toBe("translate3d(824px, 504px, 0)");

    move.focus();
    fireEvent.click(move);
    expect(overlay.style.transform).toBe("translate3d(24px, 504px, 0)");
    expect(move).toHaveFocus();
    // On the left half, minimize docks to the left edge.
    fireEvent.click(screen.getByRole("button", { name: "Minimize camera" }));
    expect(screen.getByRole("button", { name: "Show camera" })).toHaveClass("left-0");
  });

  it("collapses to a Show camera handle when minimized", () => {
    render(<CameraOverlay />);

    fireEvent.click(screen.getByRole("button", { name: "Minimize camera" }));

    expect(screen.queryByRole("button", { name: "Minimize camera" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show camera" }));
    expect(screen.getByRole("button", { name: "Minimize camera" })).toBeInTheDocument();
  });
});
