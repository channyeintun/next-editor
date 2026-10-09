import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
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

  it("keeps the global focus ring on both fields", () => {
    render(<CreatePlaylistModal onClose={() => {}} />);

    expect(screen.getByPlaceholderText("Playlist name")).not.toHaveClass("outline-none");
    expect(screen.getByPlaceholderText("Description (optional)")).not.toHaveClass("outline-none");
  });

  it("announces an empty name and ties the error to the name field", () => {
    render(<CreatePlaylistModal onClose={() => {}} />);
    const input = screen.getByPlaceholderText("Playlist name");
    expect(input).not.toHaveAttribute("aria-invalid");

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Playlist name can't be empty.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Playlist name can't be empty.");
  });
});
