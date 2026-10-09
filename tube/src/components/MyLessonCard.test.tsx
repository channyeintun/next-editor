import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import type { OwnedLesson } from "@next-editor/infra";

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
    useUpdateLessonName: idleMutation,
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

function startRename() {
  render(
    <MemoryRouter>
      <MyLessonCard lesson={lesson} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Lesson options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Update lesson name" }));
}

describe("MyLessonCard", () => {
  it("names the rename field", () => {
    startRename();

    const input = screen.getByRole("textbox", { name: "Lesson name" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Intro");
  });
});
