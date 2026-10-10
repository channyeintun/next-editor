import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { OwnedLesson } from "@next-editor/infra";

type MutateOptions = { onSuccess?: () => void; onError?: () => void };

const rename = vi.hoisted(() => ({
  mutate: vi.fn<(variables: unknown, options?: MutateOptions) => void>(),
  isPending: false,
}));

vi.mock("@next-editor/infra", async () => {
  const idleMutation = () => ({ mutate: vi.fn<() => void>(), isPending: false, isError: false });
  return {
    ...(await import("../../../infra/lessons/metadataLimits")),
    ...(await import("../../../infra/client/upload/thumbnailConstraints")),
    prepareThumbnail: vi.fn<(file: File) => Promise<{ file: File } | { error: string }>>(),
    usePublishFromLibrary: idleMutation,
    useUnpublishLesson: idleMutation,
    useDeleteLesson: idleMutation,
    useUpdateThumbnail: idleMutation,
    useUpdateLessonName: () => ({
      mutate: rename.mutate,
      isPending: rename.isPending,
      isError: false,
    }),
    usePlaylistsForLesson: () => ({ data: [], isPending: false, isError: false }),
    useCreatePlaylist: idleMutation,
    useAddLessonToPlaylist: idleMutation,
    useRemoveLessonFromPlaylist: idleMutation,
  };
});

const { default: MyLessonCard } = await import("./MyLessonCard");

const lesson: OwnedLesson = {
  id: "l1",
  slug: "intro",
  title: "Intro",
  description: "",
  thumbnail: "thumbs/intro.png",
  ne: "lessons/l1/l1.ne",
  duration: "1:00",
  tags: [],
  status: "published",
  publishedAt: 1,
};

function card() {
  return (
    <MemoryRouter>
      <MyLessonCard lesson={lesson} />
    </MemoryRouter>
  );
}

function openMenuItem(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Lesson options" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

function startRename() {
  const view = render(card());
  openMenuItem("Update lesson name");
  return view;
}

describe("MyLessonCard", () => {
  beforeEach(() => {
    rename.mutate.mockReset();
    rename.isPending = false;
  });

  it("keeps the click-outside backdrop out of the tab order and the accessibility tree", () => {
    render(card());
    fireEvent.click(screen.getByRole("button", { name: "Lesson options" }));

    expect(screen.queryByRole("button", { name: "Close menu" })).not.toBeInTheDocument();
    const backdrop = screen.getByLabelText("Close menu");
    expect(backdrop).toHaveAttribute("tabindex", "-1");

    fireEvent.click(backdrop);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("returns focus to the options trigger when Escape closes the menu", () => {
    render(card());
    const trigger = screen.getByRole("button", { name: "Lesson options" });
    fireEvent.click(trigger);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("focuses Cancel in the delete confirmation and returns focus to the trigger", () => {
    render(card());
    openMenuItem("Delete");

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();

    fireEvent.click(cancel);

    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lesson options" })).toHaveFocus();
  });

  it("focuses Cancel in the unpublish confirmation", () => {
    render(card());
    openMenuItem("Unpublish");

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("moves focus into the playlist popover and back to the trigger when it closes", () => {
    render(card());
    openMenuItem("Add to playlist");

    expect(screen.getByRole("dialog", { name: "Add to playlist" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lesson options" })).toHaveFocus();
  });

  it("returns focus to the trigger when the rename is cancelled", () => {
    startRename();

    fireEvent.click(screen.getByRole("button", { name: "Cancel rename" }));

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lesson options" })).toHaveFocus();
  });

  it("returns focus to the trigger once a saved rename settles", () => {
    let settle: (() => void) | undefined;
    rename.mutate.mockImplementation((_variables, options) => {
      settle = options?.onSuccess;
    });
    const view = startRename();
    fireEvent.change(screen.getByRole("textbox", { name: "Lesson name" }), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save lesson name" }));
    rename.isPending = true;
    view.rerender(card());
    const trigger = screen.getByRole("button", { name: "Lesson options" });
    expect(trigger).toBeDisabled();

    act(() => settle?.());
    expect(trigger).not.toHaveFocus();

    rename.isPending = false;
    view.rerender(card());

    expect(trigger).toHaveFocus();
  });

  it("names the rename field", () => {
    startRename();

    const input = screen.getByRole("textbox", { name: "Lesson name" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Intro");
  });

  it("keeps the global focus ring on the rename field", () => {
    startRename();

    expect(screen.getByRole("textbox", { name: "Lesson name" })).not.toHaveClass("outline-none");
  });

  it("announces an empty name and ties the error to the rename field", () => {
    startRename();
    const input = screen.getByRole("textbox", { name: "Lesson name" });
    expect(input).not.toHaveAttribute("aria-invalid");

    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("alert")).toHaveTextContent("Lesson name can't be empty.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Lesson name can't be empty.");
    expect(rename.mutate).not.toHaveBeenCalled();
  });

  it("announces a failed rename", () => {
    rename.mutate.mockImplementation((_variables, options) => options?.onError?.());
    startRename();
    const input = screen.getByRole("textbox", { name: "Lesson name" });

    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save lesson name" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't update the lesson name — try again.",
    );
  });

  it("exposes the in-flight rename as a status message", () => {
    const view = startRename();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    rename.isPending = true;
    view.rerender(card());

    expect(screen.getByRole("status")).toHaveTextContent("Updating lesson name…");
  });
});
