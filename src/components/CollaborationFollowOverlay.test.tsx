import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { useCollaboration } from "../contexts/CollaborationContext";

type CollaborationContextValue = ReturnType<typeof useCollaboration>;

const stopFollowing = vi.fn<CollaborationContextValue["stopFollowing"]>();
let targetSurface: Record<string, unknown> = { kind: "slides", isMaximized: true };
let isFollowing = true;
let isInRoom = true;

vi.mock("../contexts/CollaborationContext", () => ({
  useOptionalCollaboration: () => ({
    provider: isInRoom ? {} : null,
    getPathForNodeId: () => "src/index.ts",
    stopFollowing,
  }),
}));
vi.mock("../contexts/collaboration/RoomPresenceContext", () => ({
  useOptionalRoomPresence: () => ({
    followedParticipant: isFollowing
      ? {
          actorId: "10000000-0000-4000-8000-000000000001",
          sessionId: "20000000-0000-4000-8000-000000000001",
          username: "ada",
          name: "Ada",
          surface: targetSurface,
        }
      : null,
  }),
}));

import CollaborationFollowOverlay from "./CollaborationFollowOverlay";

describe("CollaborationFollowOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    targetSurface = { kind: "slides", isMaximized: true };
    isFollowing = true;
    isInRoom = true;
  });

  it("announces the exact target and active surface without taking focus", () => {
    const before = document.activeElement;
    const view = render(<CollaborationFollowOverlay />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Following Ada, Slides. Press Escape to stop.",
    );
    expect(screen.getByText("Following Ada · Slides · Esc to stop")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(document.activeElement).toBe(before);

    targetSurface = {
      kind: "whiteboard",
      isMaximized: false,
      viewport: { scrollX: 0, scrollY: 0, zoom: 1 },
    };
    view.rerender(<CollaborationFollowOverlay />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Following Ada, Whiteboard. Press Escape to stop.",
    );
  });

  // A status region inserted already filled is often not announced, so the
  // region exists, empty, before following starts and stays after it stops.
  it("keeps one status region mounted across starting and stopping", () => {
    isFollowing = false;
    const view = render(<CollaborationFollowOverlay />);
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

    isFollowing = true;
    view.rerender(<CollaborationFollowOverlay />);
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Following Ada, Slides. Press Escape to stop.");

    isFollowing = false;
    view.rerender(<CollaborationFollowOverlay />);
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toBeEmptyDOMElement();
  });

  it("provides an explicit stop control above modal surfaces", () => {
    render(<CollaborationFollowOverlay />);
    const stop = screen.getByRole("button", { name: "Stop" });
    stop.focus();
    fireEvent.click(stop);

    expect(stopFollowing).toHaveBeenCalledWith("user");
  });

  it("adds no status region outside a room", () => {
    isInRoom = false;
    isFollowing = false;
    render(<CollaborationFollowOverlay />);

    expect(screen.queryByRole("status")).toBeNull();
  });
});
