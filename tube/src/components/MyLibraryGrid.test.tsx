import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const queries = vi.hoisted(() => ({
  lessonsError: false,
  playlistsError: false,
  lessons: [] as { id: string; title: string }[],
}));

vi.mock("@next-editor/infra", () => ({
  useMyLessons: () => ({
    data: queries.lessonsError ? undefined : queries.lessons,
    isPending: false,
    isError: queries.lessonsError,
    refetch: vi.fn<() => void>(),
  }),
  useMyPlaylists: () => ({
    data: queries.playlistsError ? undefined : [],
    isPending: false,
    isError: queries.playlistsError,
    refetch: vi.fn<() => void>(),
  }),
}));

// A lesson card is beside the point here; only its h3 title matters.
vi.mock("./MyLessonCard", () => ({
  default: ({ lesson }: { lesson: { title: string } }) => <h3>{lesson.title}</h3>,
}));

const { default: MyLibraryGrid } = await import("./MyLibraryGrid");

function renderGrid() {
  render(
    <MemoryRouter>
      <MyLibraryGrid />
    </MemoryRouter>,
  );
}

describe("MyLibraryGrid", () => {
  beforeEach(() => {
    queries.lessonsError = false;
    queries.playlistsError = false;
    queries.lessons = [];
  });

  it("announces a failed lessons load", () => {
    queries.lessonsError = true;
    renderGrid();

    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load your lessons");
  });

  it("announces a failed playlists load", () => {
    queries.playlistsError = true;
    renderGrid();

    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load your playlists");
  });

  it("shows no alert when both loads succeed", () => {
    renderGrid();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("puts the lesson titles under a Lessons heading, not under Playlists", () => {
    queries.lessons = [{ id: "l1", title: "Closures in Rust" }];
    renderGrid();

    const outline = screen
      .getAllByRole("heading")
      .map((heading) => `${heading.tagName} ${heading.textContent}`);
    expect(outline).toEqual(["H2 Playlists", "H2 Lessons", "H3 Closures in Rust"]);
  });

  it("adds no Lessons heading when there are no lessons", () => {
    renderGrid();

    expect(screen.queryByRole("heading", { name: "Lessons" })).not.toBeInTheDocument();
  });
});
