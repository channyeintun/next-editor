import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { OwnedPlaylist } from "@next-editor/infra";

type MutateOptions = { onSettled?: () => void; onError?: () => void };

const removeLesson = vi.hoisted(() =>
  vi.fn<(variables: unknown, options?: MutateOptions) => void>(),
);

vi.mock("@next-editor/infra", () => ({
  usePlaylistLessons: () => ({
    data: [
      { id: "l1", title: "Intro", status: "published" },
      { id: "l2", title: "Old draft", status: "draft" },
    ],
    isPending: false,
  }),
  useRemoveLessonFromPlaylist: () => ({ mutate: removeLesson, isPending: false }),
  useReorderPlaylistLessons: () => ({ mutate: vi.fn<() => void>(), isPending: false }),
}));

const { default: PlaylistManagePanel } = await import("./PlaylistManagePanel");

const playlist: OwnedPlaylist = {
  id: "p1",
  slug: "rust-basics",
  title: "Rust basics",
  description: "",
  lessonCount: 1,
  updatedAt: 1,
  thumbnail: null,
};

/** The card's options trigger that opens the panel, the way PlaylistsSection does. */
function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Playlist options
      </button>
      {open ? (
        <PlaylistManagePanel
          playlist={playlist}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function openPanel(onClose = vi.fn<() => void>()) {
  render(<Harness onClose={onClose} />);
  const opener = screen.getByRole("button", { name: "Playlist options" });
  opener.focus();
  fireEvent.click(opener);
  return { opener, onClose };
}

describe("PlaylistManagePanel", () => {
  it("is a modal dialog named by its heading, with focus on Close", () => {
    openPanel();

    const dialog = screen.getByRole("dialog", { name: "Manage “Rust basics”" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("closes once on Escape and returns focus to the opener", () => {
    const { opener, onClose } = openPanel();

    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("still closes on Escape when focus has fallen to the page", () => {
    const { onClose } = openPanel();
    screen.getByRole("button", { name: "Close" }).blur();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("wraps Tab inside the dialog", () => {
    openPanel();
    const close = screen.getByRole("button", { name: "Close" });
    const lastRemove = screen.getAllByRole("button", { name: "Remove" }).at(-1)!;

    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(lastRemove).toHaveFocus();

    fireEvent.keyDown(lastRemove, { key: "Tab" });
    expect(close).toHaveFocus();
  });

  it("announces a failed remove", () => {
    removeLesson.mockImplementation((_variables, options) => {
      options?.onError?.();
      options?.onSettled?.();
    });
    render(<PlaylistManagePanel playlist={playlist} onClose={() => {}} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't remove that lesson — try again.");
  });

  it("keeps draft member titles and the footer hint at AA contrast", () => {
    render(<PlaylistManagePanel playlist={playlist} onClose={() => {}} />);

    expect(screen.getByText("Intro")).toHaveClass("text-slate-300");
    expect(screen.getByText("Old draft")).toHaveClass("text-slate-400");
    expect(screen.getByText(/Add more from a lesson's own menu/)).toHaveClass("text-slate-400");
  });
});
