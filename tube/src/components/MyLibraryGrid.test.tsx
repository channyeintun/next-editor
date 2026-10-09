import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const queries = vi.hoisted(() => ({ lessonsError: false, playlistsError: false }));

vi.mock("@next-editor/infra", () => ({
  useMyLessons: () => ({
    data: queries.lessonsError ? undefined : [],
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
});
