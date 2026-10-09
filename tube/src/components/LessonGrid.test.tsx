/* oxlint-disable vitest/require-mock-type-parameters */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The gallery's infinite query, as each test sets it.
let gallery: Record<string, unknown>;
// The backend search query, as each test sets it.
let searchState: Record<string, unknown>;

vi.mock("../hooks/useLessons", () => ({
  useLessonsInfinite: () => gallery,
}));
vi.mock("@next-editor/infra", () => ({
  useSearch: () => searchState,
}));
vi.mock("./SearchResults", () => ({
  default: ({ query }: { query: string }) => <p>results for {query}</p>,
}));
vi.mock("./LessonCard", () => ({
  default: ({ lesson }: { lesson: { title: string } }) => <p>{lesson.title}</p>,
}));

const { default: LessonGrid } = await import("./LessonGrid");

function galleryState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: undefined,
    error: null,
    isPending: false,
    isError: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  searchState = { isPending: true, isError: false, data: undefined };
  vi.useFakeTimers();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LessonGrid search while page 0 is a network fetch", () => {
  it("keeps the search box when a search starts before the first page lands", () => {
    gallery = galleryState({ isPending: true });
    render(<LessonGrid />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search authors and lessons" }), {
      target: { value: "rust" },
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText("results for rust")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search authors and lessons" })).toHaveValue("rust");
  });

  it("does not replace search results with the gallery's page-0 error", () => {
    gallery = galleryState({ isPending: true });
    const view = render(<LessonGrid />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search authors and lessons" }), {
      target: { value: "rust" },
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    gallery = galleryState({ isError: true, error: new Error("Request failed") });
    view.rerender(<LessonGrid />);

    expect(screen.getByText("results for rust")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("still shows the full-page error when page 0 fails and nobody is searching", () => {
    gallery = galleryState({ isError: true, error: new Error("Request failed") });
    render(<LessonGrid />);

    expect(screen.getByRole("alert")).toHaveTextContent("Request failed");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

function typeQuery(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Search authors and lessons" }), {
    target: { value },
  });
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

describe("LessonGrid status messages", () => {
  it("announces the first page loading, then searching, through one persistent region", () => {
    gallery = galleryState({ isPending: true });
    render(<LessonGrid />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading lessons…");

    typeQuery("rust");

    // The same node, not a fresh one mounted with its text, so the change is read.
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Searching…");
  });

  it("announces when a search matches nothing", () => {
    gallery = galleryState({ isPending: true });
    searchState = { isPending: false, isError: false, data: { authors: [], lessons: [] } };
    render(<LessonGrid />);

    typeQuery("zzz");

    expect(screen.getByRole("status")).toHaveTextContent(
      "No authors or lessons match your search.",
    );
  });

  it("announces how many lessons and authors a search found", () => {
    gallery = galleryState({ isPending: true });
    searchState = {
      isPending: false,
      isError: false,
      data: { authors: [{ username: "chan" }], lessons: [{ slug: "a" }, { slug: "b" }] },
    };
    render(<LessonGrid />);

    typeQuery("rust");

    expect(screen.getByRole("status")).toHaveTextContent("2 lessons and 1 author found");
  });

  it("leaves a failed search to its alert instead of the status region", () => {
    gallery = galleryState({ isPending: true });
    searchState = { isPending: false, isError: true, data: undefined };
    render(<LessonGrid />);

    typeQuery("rust");

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("announces while the next page of lessons is loading", () => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    gallery = galleryState({
      isFetchingNextPage: true,
      hasNextPage: true,
      data: { pages: [{ lessons: [{ slug: "intro", title: "Intro" }], nextPage: "d1:1" }] },
    });
    render(<LessonGrid />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading more lessons…");
  });

  it("announces a failed page fetch as an alert", () => {
    gallery = galleryState({
      isFetchNextPageError: true,
      isError: true,
      error: new Error("Network down"),
      data: { pages: [{ lessons: [{ slug: "intro", title: "Intro" }], nextPage: "d1:1" }] },
    });
    render(<LessonGrid />);

    expect(screen.getByRole("alert")).toHaveTextContent("Network down");
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
  });
});
