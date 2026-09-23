import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MAX_DESCRIPTION_CHARS, MAX_TITLE_CHARS } from "../../../infra/lessons/metadataLimits";

vi.mock("@next-editor/infra", async () => ({
  ...(await import("../../../infra/lessons/metadataLimits")),
  useCreatePlaylist: () => ({ mutate: vi.fn<() => void>(), isPending: false }),
}));

const { default: CreatePlaylistModal } = await import("./CreatePlaylistModal");

describe("CreatePlaylistModal", () => {
  it("caps the name and description at the Worker's limits", () => {
    render(<CreatePlaylistModal onClose={() => {}} />);

    expect(screen.getByPlaceholderText<HTMLInputElement>("Playlist name").maxLength).toBe(
      MAX_TITLE_CHARS,
    );
    expect(screen.getByPlaceholderText<HTMLInputElement>("Description (optional)").maxLength).toBe(
      MAX_DESCRIPTION_CHARS,
    );
  });
});
