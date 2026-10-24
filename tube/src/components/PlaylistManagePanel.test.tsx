import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { OwnedPlaylist } from "@next-editor/infra";

type MutateOptions = { onSettled?: () => void; onError?: () => void };
type AddOptions = {
  onSuccess?: (outcome: { added: string[]; alreadyAdded: string[]; notEligible: string[] }) => void;
  onError?: () => void;
};

const removeLesson = vi.hoisted(() =>
  vi.fn<(variables: unknown, options?: MutateOptions) => void>(),
);
const saveOrder = vi.hoisted(() =>
  vi.fn<(playlistId: string, lessonIds: string[]) => Promise<void>>(),
);
const addLessons = vi.hoisted(() =>
  vi.fn<(variables: { playlistId: string; lessonIds: string[] }, options?: AddOptions) => void>(),
);

vi.mock("@next-editor/infra", () => ({
  usePlaylistLessons: () => ({
    data: [
      { id: "l1", title: "Intro", status: "published" },
      { id: "l2", title: "Old draft", status: "draft" },
      { id: "l3", title: "CSS course 10: Sizing", status: "published" },
      { id: "l4", title: "CSS course 2: Box model", status: "published" },
    ],
    isPending: false,
  }),
  useMyLessons: () => ({
    data: [
      { id: "l1", title: "Intro", status: "published" },
      { id: "c11", title: "CSS course 11: Variables", status: "published" },
      { id: "c3", title: "CSS course 3: Selectors", status: "published" },
      { id: "draft", title: "CSS course 12: Draft", status: "draft" },
      { id: "rust", title: "Rust: Ownership", status: "published" },
    ],
    isPending: false,
  }),
  useRemoveLessonFromPlaylist: () => ({ mutate: removeLesson, isPending: false }),
  useSavePlaylistOrder: () => saveOrder,
  useAddLessonsToPlaylist: () => ({ mutate: addLessons, isPending: false }),
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

  it("keeps draft member titles and the hint at AA contrast", () => {
    render(<PlaylistManagePanel playlist={playlist} onClose={() => {}} />);

    expect(screen.getByText("Intro")).toHaveClass("text-slate-300");
    expect(screen.getByText("Old draft")).toHaveClass("text-slate-400");
    expect(screen.getByText(/Changes save as you go/)).toHaveClass("text-slate-400");
  });
});

/** The member titles in the order the panel lists them. */
const listedTitles = () =>
  screen
    .getAllByRole("listitem")
    .map((item) => item.querySelector("span.min-w-0")?.textContent?.replace("Draft", "").trim());

describe("PlaylistManagePanel ordering", () => {
  beforeEach(() => {
    saveOrder.mockReset();
    saveOrder.mockResolvedValue();
  });

  it("sorts the whole playlist by title in one save", () => {
    render(<PlaylistManagePanel playlist={playlist} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Sort by title" }));

    expect(listedTitles()).toEqual([
      "CSS course 2: Box model",
      "CSS course 10: Sizing",
      "Intro",
      "Old draft",
    ]);
    expect(saveOrder).toHaveBeenCalledOnce();
    expect(saveOrder).toHaveBeenCalledWith("p1", ["l4", "l3", "l1", "l2"]);
    expect(screen.getByRole("status")).toHaveTextContent("Sorted the playlist by title.");
  });

  it("moves a lesson to the top at once, and says where it went", () => {
    render(<PlaylistManagePanel playlist={playlist} onClose={() => {}} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Move to top" })[3]);

    expect(listedTitles()[0]).toBe("CSS course 2: Box model");
    expect(saveOrder).toHaveBeenCalledWith("p1", ["l4", "l1", "l2", "l3"]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Moved CSS course 2: Box model to position 1 of 4.",
    );
  });

  it("drops a dragged lesson after the row it is released over", () => {
    render(<PlaylistManagePanel playlist={playlist} onClose={() => {}} />);
    const rows = screen.getAllByRole("listitem");
    const dataTransfer = { setData: () => {}, effectAllowed: "", dropEffect: "" };
    // The lower half of a row means "after it".
    rows[2].getBoundingClientRect = () => ({ top: 100, height: 20 }) as DOMRect;

    fireEvent.dragStart(rows[0], { dataTransfer });
    // jsdom has no DragEvent, so the pointer position goes on the event itself.
    const over = createEvent.dragOver(rows[2], { dataTransfer });
    Object.defineProperty(over, "clientY", { value: 115 });
    fireEvent(rows[2], over);
    fireEvent.drop(rows[2], { dataTransfer });

    expect(saveOrder).toHaveBeenCalledWith("p1", ["l2", "l3", "l1", "l4"]);
  });

  it("goes back to the saved order and says so when a save fails", async () => {
    saveOrder.mockRejectedValue(new Error("offline"));
    render(<PlaylistManagePanel playlist={playlist} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Sort by title" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't save the new order — try again.",
    );
    expect(listedTitles()[0]).toBe("Intro");
  });
});

describe("PlaylistManagePanel adding", () => {
  beforeEach(() => addLessons.mockReset());

  it("adds every filtered lesson in one request, in title order", () => {
    addLessons.mockImplementation((_variables, options) =>
      options?.onSuccess?.({ added: ["c3", "c11"], alreadyAdded: [], notEligible: [] }),
    );
    render(<PlaylistManagePanel playlist={playlist} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Add lessons" }));

    // Members and unpublished lessons are not offered.
    expect(screen.queryByText("Intro")).not.toBeInTheDocument();
    expect(screen.queryByText("CSS course 12: Draft")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter your published lessons" }), {
      target: { value: "css course" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all 2 shown" }));
    fireEvent.click(screen.getByRole("button", { name: "Add 2 lessons" }));

    expect(addLessons).toHaveBeenCalledWith(
      { playlistId: "p1", lessonIds: ["c3", "c11"] },
      expect.anything(),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Added 2 lessons.");
    expect(screen.getByRole("tab", { name: /^Lessons/ })).toHaveAttribute("aria-selected", "true");
  });
});
