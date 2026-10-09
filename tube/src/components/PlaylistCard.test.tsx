import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import type { OwnedPlaylist } from "@next-editor/infra";

vi.mock("@next-editor/infra", async () => {
  const idleMutation = () => ({ mutate: vi.fn<() => void>(), isPending: false });
  return {
    ...(await import("../../../infra/lessons/metadataLimits")),
    useUpdatePlaylist: idleMutation,
    useDeletePlaylist: idleMutation,
  };
});

const { default: PlaylistCard } = await import("./PlaylistCard");

const playlist: OwnedPlaylist = {
  id: "p1",
  slug: "rust-basics",
  title: "Rust basics",
  description: "",
  lessonCount: 2,
  updatedAt: 1,
  thumbnail: null,
};

function startRename() {
  render(
    <MemoryRouter>
      <PlaylistCard
        playlist={playlist}
        isManaging={false}
        onManage={() => {}}
        onDeleted={() => {}}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Playlist options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
}

describe("PlaylistCard", () => {
  it("names the rename field", () => {
    startRename();

    const input = screen.getByRole("textbox", { name: "Playlist name" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Rust basics");
  });
});
