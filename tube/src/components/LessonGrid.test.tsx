/* oxlint-disable vitest/require-mock-type-parameters */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The gallery's infinite query, as each test sets it.
let gallery: Record<string, unknown>;

vi.mock("../hooks/useLessons", () => ({
  useLessonsInfinite: () => gallery,
}));
vi.mock("./SearchResults", () => ({
  default: ({ query }: { query: string }) => <p>results for {query}</p>,
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

    expect(screen.getByText("Request failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
