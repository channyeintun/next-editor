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

function renderCard(onManage: () => void = () => {}, overrides: Partial<OwnedPlaylist> = {}) {
  render(
    <MemoryRouter>
      <PlaylistCard
        playlist={{ ...playlist, ...overrides }}
        isManaging={false}
        onManage={onManage}
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

  it("returns focus to the options trigger when Escape closes the menu", () => {
    renderCard();
    const trigger = screen.getByRole("button", { name: "Playlist options" });
    fireEvent.click(trigger);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("focuses Cancel in the delete confirmation and returns focus to the trigger", () => {
    renderCard();
    openMenuItem("Delete");

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();

    fireEvent.click(cancel);

    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Playlist options" })).toHaveFocus();
  });

  it("returns focus to the trigger when the rename is cancelled", () => {
    renderCard();
    openMenuItem("Rename");

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Playlist name" }), { key: "Escape" });

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Playlist options" })).toHaveFocus();
  });

  it("focuses the options trigger before opening the manage panel", () => {
    let focusedOnManage: Element | null = null;
    renderCard(() => {
      focusedOnManage = document.activeElement;
    });

    openMenuItem("Manage lessons");

    expect(focusedOnManage).toBe(screen.getByRole("button", { name: "Playlist options" }));
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

  it("says what the lesson-count badge counts", () => {
    renderCard();
    // The badge's icon is decorative; hidden text names the unit.
    expect(screen.getByText("2").textContent).toBe("2 lessons");
  });

  it("uses the singular for a one-lesson playlist", () => {
    renderCard(undefined, { lessonCount: 1 });
    expect(screen.getByText("1").textContent).toBe("1 lesson");
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
