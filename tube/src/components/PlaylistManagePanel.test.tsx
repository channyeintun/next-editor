import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { OwnedPlaylist } from "@next-editor/infra";

type MutateOptions = { onSettled?: () => void; onError?: () => void };

const removeLesson = vi.hoisted(() =>
  vi.fn<(variables: unknown, options?: MutateOptions) => void>(),
);

vi.mock("@next-editor/infra", () => ({
  usePlaylistLessons: () => ({
    data: [{ id: "l1", title: "Intro", status: "published" }],
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

describe("PlaylistManagePanel", () => {
  it("announces a failed remove", () => {
    removeLesson.mockImplementation((_variables, options) => {
      options?.onError?.();
      options?.onSettled?.();
    });
    render(<PlaylistManagePanel playlist={playlist} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't remove that lesson — try again.");
  });
});
