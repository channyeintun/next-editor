import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useCollaboration } from "../contexts/CollaborationContext";

type CollaborationContextValue = ReturnType<typeof useCollaboration>;

const stopFollowing = vi.fn<CollaborationContextValue["stopFollowing"]>();
let targetSurface: Record<string, unknown> = { kind: "slides", isMaximized: true };

vi.mock("../contexts/CollaborationContext", () => ({
  useOptionalCollaboration: () => ({
    followedParticipant: {
      actorId: "10000000-0000-4000-8000-000000000001",
      sessionId: "20000000-0000-4000-8000-000000000001",
      username: "ada",
      name: "Ada",
      surface: targetSurface,
    },
    getPathForNodeId: () => "src/index.ts",
    stopFollowing,
  }),
}));

import CollaborationFollowOverlay from "./CollaborationFollowOverlay";

describe("CollaborationFollowOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    targetSurface = { kind: "slides", isMaximized: true };
  });

  it("announces the exact target and active surface without taking focus", () => {
    const before = document.activeElement;
    const view = render(<CollaborationFollowOverlay />);

    expect(screen.getByRole("status")).toHaveTextContent("Following Ada · Slides · Esc to stop");
    expect(document.activeElement).toBe(before);

    targetSurface = {
      kind: "whiteboard",
      isMaximized: false,
      viewport: { scrollX: 0, scrollY: 0, zoom: 1 },
    };
    view.rerender(<CollaborationFollowOverlay />);
    expect(screen.getByRole("status")).toHaveTextContent("Following Ada · Whiteboard");
  });

  it("provides an explicit stop control above modal surfaces", () => {
    render(<CollaborationFollowOverlay />);
    const stop = screen.getByRole("button", { name: "Stop" });
    stop.focus();
    fireEvent.click(stop);

    expect(stopFollowing).toHaveBeenCalledWith("user");
  });
});
