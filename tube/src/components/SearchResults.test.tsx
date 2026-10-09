import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The backend search query, as each test sets it.
let searchState: Record<string, unknown>;

vi.mock("@next-editor/infra", () => ({
  useSearch: () => searchState,
  avatarProxyUrl: (url: string) => url,
}));
vi.mock("./LessonCard", () => ({
  default: ({ lesson }: { lesson: { title: string } }) => <h3>{lesson.title}</h3>,
}));

const { default: SearchResults } = await import("./SearchResults");

function renderResults() {
  return render(
    <MemoryRouter>
      <SearchResults query="rust" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  searchState = {
    isPending: false,
    isError: false,
    refetch: vi.fn<() => void>(),
    data: { authors: [], lessons: [] },
  };
});

describe("SearchResults", () => {
  it("names an author link by the author alone, not the decorative avatar initial", () => {
    searchState.data = {
      authors: [{ username: "chan", name: "Chan Nyein Tun", avatarUrl: null }],
      lessons: [],
    };
    renderResults();

    expect(screen.getByRole("link", { name: "Chan Nyein Tun" })).toHaveAttribute(
      "href",
      "/learn/@chan",
    );
  });

  it("heads the matching lessons with their own section, not the Authors one", () => {
    searchState.data = {
      authors: [{ username: "chan", name: "Chan Nyein Tun", avatarUrl: null }],
      lessons: [{ slug: "closures", title: "Closures in Rust" }],
    };
    renderResults();

    const headings = screen.getAllByRole("heading");
    expect(headings.map((h) => [h.tagName, h.textContent])).toEqual([
      ["H2", "Authors"],
      ["H2", "Lessons"],
      ["H3", "Closures in Rust"],
    ]);
  });

  it("has no Lessons heading when only authors match", () => {
    searchState.data = {
      authors: [{ username: "chan", name: "Chan Nyein Tun", avatarUrl: null }],
      lessons: [],
    };
    renderResults();

    expect(screen.queryByRole("heading", { name: "Lessons" })).not.toBeInTheDocument();
  });
});
