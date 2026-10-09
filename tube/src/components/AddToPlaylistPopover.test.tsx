import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { OwnedLesson } from "@next-editor/infra";
import { MAX_TITLE_CHARS } from "../../../infra/lessons/metadataLimits";

type MutateOptions = { onSuccess?: (created: { id: string }) => void; onError?: () => void };

const createPlaylist = vi.hoisted(() =>
  vi.fn<(variables: { title: string }, options?: MutateOptions) => void>(),
);

vi.mock("@next-editor/infra", async () => {
  const idleMutation = () => ({ mutate: vi.fn<() => void>(), isPending: false });
  return {
    ...(await import("../../../infra/lessons/metadataLimits")),
    usePlaylistsForLesson: () => ({ data: [], isPending: false, isError: false }),
    useCreatePlaylist: () => ({ mutate: createPlaylist, isPending: false }),
    useAddLessonToPlaylist: idleMutation,
    useRemoveLessonFromPlaylist: idleMutation,
  };
});

const { default: AddToPlaylistPopover } = await import("./AddToPlaylistPopover");

const lesson: OwnedLesson = {
  id: "l1",
  slug: "intro",
  title: "Intro",
  description: "",
  thumbnail: "",
  ne: "lessons/l1/l1.ne",
  duration: "1:00",
  tags: [],
  status: "draft",
  publishedAt: null,
};

describe("AddToPlaylistPopover", () => {
  it("caps a new playlist's name at the Worker's limit", () => {
    render(<AddToPlaylistPopover lesson={lesson} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /new playlist/i }));

    expect(screen.getByPlaceholderText<HTMLInputElement>("Playlist name").maxLength).toBe(
      MAX_TITLE_CHARS,
    );
  });

  it("keeps the global focus ring on the quick-create field", () => {
    render(<AddToPlaylistPopover lesson={lesson} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /new playlist/i }));

    expect(screen.getByPlaceholderText("Playlist name")).not.toHaveClass("outline-none");
  });

  it("announces a failed quick-create", () => {
    createPlaylist.mockImplementation((_variables, options) => options?.onError?.());
    render(<AddToPlaylistPopover lesson={lesson} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /new playlist/i }));
    const input = screen.getByPlaceholderText("Playlist name");

    fireEvent.change(input, { target: { value: "Rust basics" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't create the playlist — try again.",
    );
  });
});
