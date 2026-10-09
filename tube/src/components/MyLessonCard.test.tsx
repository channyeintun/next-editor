import { fireEvent, render, screen } from "@testing-library/react";
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
    resizeThumbnail: vi.fn<(file: File) => Promise<File>>(),
    usePublishFromLibrary: idleMutation,
    useUnpublishLesson: idleMutation,
    useDeleteLesson: idleMutation,
    useUpdateThumbnail: idleMutation,
    useUpdateLessonName: () => ({
      mutate: rename.mutate,
      isPending: rename.isPending,
      isError: false,
    }),
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

function startRename() {
  const view = render(card());
  fireEvent.click(screen.getByRole("button", { name: "Lesson options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Update lesson name" }));
  return view;
}

describe("MyLessonCard", () => {
  beforeEach(() => {
    rename.mutate.mockReset();
    rename.isPending = false;
  });

  it("names the rename field", () => {
    startRename();

    const input = screen.getByRole("textbox", { name: "Lesson name" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Intro");
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
