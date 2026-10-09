import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { OwnedPlaylist } from "@next-editor/infra";

type MutateOptions = { onSuccess?: () => void; onError?: () => void };

const del = vi.hoisted(() => vi.fn<(id: string, options?: MutateOptions) => void>());

vi.mock("@next-editor/infra", async () => ({
  ...(await import("../../../infra/lessons/metadataLimits")),
  useUpdatePlaylist: () => ({ mutate: vi.fn<() => void>(), isPending: false }),
  useDeletePlaylist: () => ({ mutate: del, isPending: false }),
}));

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

function renderCard() {
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
}

function openMenuItem(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Playlist options" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

describe("PlaylistCard", () => {
  beforeEach(() => {
    del.mockReset();
  });

  it("keeps the click-outside backdrop out of the tab order and the accessibility tree", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Playlist options" }));

    expect(screen.queryByRole("button", { name: "Close menu" })).not.toBeInTheDocument();
    const backdrop = screen.getByLabelText("Close menu");
    expect(backdrop).toHaveAttribute("tabindex", "-1");

    fireEvent.click(backdrop);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("names the rename field", () => {
    renderCard();
    openMenuItem("Rename");

    const input = screen.getByRole("textbox", { name: "Playlist name" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Rust basics");
  });

  it("keeps the global focus ring on the rename field", () => {
    renderCard();
    openMenuItem("Rename");

    expect(screen.getByRole("textbox", { name: "Playlist name" })).not.toHaveClass("outline-none");
  });

  it("announces an empty name and ties the error to the rename field", () => {
    renderCard();
    openMenuItem("Rename");
    const input = screen.getByRole("textbox", { name: "Playlist name" });
    expect(input).not.toHaveAttribute("aria-invalid");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save playlist name" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Playlist name can't be empty.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Playlist name can't be empty.");
  });

  it("announces a failed delete", () => {
    del.mockImplementation((_id, options) => options?.onError?.());
    renderCard();
    openMenuItem("Delete");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't delete the playlist — try again.",
    );
  });
});
