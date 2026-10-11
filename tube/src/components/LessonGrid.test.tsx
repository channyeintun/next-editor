/* oxlint-disable vitest/require-mock-type-parameters */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The gallery's infinite query, as each test sets it.
let gallery: Record<string, unknown>;
// The backend search query, as each test sets it, and every query it was asked for.
let searchState: Record<string, unknown>;
const searchedFor = vi.hoisted(() => [] as string[]);

vi.mock("../hooks/useLessons", () => ({
  useLessonsInfinite: () => gallery,
}));
vi.mock("@next-editor/infra", () => ({
  useSearch: (query: string) => {
    searchedFor.push(query);
    return searchState;
  },
}));
vi.mock("./SearchResults", () => ({
  default: () => <p>search results</p>,
}));
// Warming the lesson route would import the whole lesson player.
vi.mock("../hooks/useWarmLessonRoute", () => ({ useWarmLessonRoute: () => {} }));
vi.mock("./LessonCard", () => ({
  default: ({ lesson }: { lesson: { title: string } }) => <p>{lesson.title}</p>,
}));
const firstRow = vi.hoisted(() => ({
  observe: vi.fn<(row: HTMLElement | null) => void>(),
  settleWithout: vi.fn<() => void>(),
}));
vi.mock("../lib/firstRowThumbnails", () => ({
  observeFirstRowThumbnails: firstRow.observe,
  settleWithoutFirstRow: firstRow.settleWithout,
  whenFirstRowThumbnailsSettled: () => new Promise<void>(() => {}),
}));
// The real window virtualizer, recording the scrollMargin of every render.
const scrollMargins = vi.hoisted(() => [] as (number | undefined)[]);
vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-virtual")>();
  return {
    ...actual,
    useWindowVirtualizer: ((options) => {
      scrollMargins.push(options.scrollMargin);
      return actual.useWindowVirtualizer(options);
    }) satisfies typeof actual.useWindowVirtualizer,
  };
});

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
  firstRow.observe.mockClear();
  firstRow.settleWithout.mockClear();
  searchState = { isPending: true, isError: false, data: undefined };
  searchedFor.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LessonGrid search while page 0 is a network fetch", () => {
  it("keeps the search box when a search starts before the first page lands", () => {
    gallery = galleryState({ isPending: true });
    const view = render(<LessonGrid />);

    typeQuery("rust");

    // Until the search answers, the (loading) gallery stays on screen, dimmed.
    expect(screen.queryByText("search results")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search authors and lessons" })).toHaveValue("rust");

    searchState = { isPending: false, isError: false, data: { authors: [], lessons: [] } };
    view.rerender(<LessonGrid />);
    expect(screen.getByText("search results")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search authors and lessons" })).toHaveValue("rust");
  });

  it("does not replace search results with the gallery's page-0 error", () => {
    gallery = galleryState({ isPending: true });
    searchState = { isPending: false, isError: false, data: { authors: [], lessons: [] } };
    const view = render(<LessonGrid />);
    typeQuery("rust");

    gallery = galleryState({ isError: true, error: new Error("Request failed") });
    view.rerender(<LessonGrid />);

    expect(screen.getByText("search results")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("still shows the full-page error when page 0 fails and nobody is searching", () => {
    gallery = galleryState({ isError: true, error: new Error("Request failed") });
    render(<LessonGrid />);

    expect(screen.getByRole("alert")).toHaveTextContent("Request failed");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

/** Types `value` into the search field and presses Enter. */
function typeQuery(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Search authors and lessons" }), {
    target: { value },
  });
  fireEvent.submit(screen.getByRole("search"));
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

describe("LessonGrid clear search", () => {
  it("returns focus to the search field when Clear search removes itself", () => {
    gallery = galleryState({ isPending: true });
    render(<LessonGrid />);
    typeQuery("rust");

    const clear = screen.getByRole("button", { name: "Clear search" });
    clear.focus();
    fireEvent.click(clear);

    const field = screen.getByRole("textbox", { name: "Search authors and lessons" });
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    expect(field).toHaveValue("");
    expect(field).toHaveFocus();
    // The gallery is back at once, and the field is the same element, so it keeps focus.
    expect(screen.queryByText("search results")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search authors and lessons" })).toHaveFocus();
  });
});

describe("LessonGrid search on Enter", () => {
  const introPage = { pages: [{ lessons: [{ slug: "intro", title: "Intro" }], nextPage: null }] };
  const found = { isPending: false, isError: false, data: { authors: [], lessons: [] } };

  it("does not search while the reader types, only when they press Enter", () => {
    gallery = galleryState({ data: introPage });
    searchState = found;
    render(<LessonGrid />);
    const field = screen.getByRole("textbox", { name: "Search authors and lessons" });

    for (const value of ["r", "ru", "rus", "rust"]) {
      fireEvent.change(field, { target: { value } });
    }
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(searchedFor.filter(Boolean)).toEqual([]);
    expect(screen.getByText("Intro")).toBeInTheDocument();

    fireEvent.submit(screen.getByRole("search"));
    expect(searchedFor.at(-1)).toBe("rust");
    expect(screen.getByText("search results")).toBeInTheDocument();
  });

  it("keeps the gallery on screen, dimmed and busy, until the first search answers", () => {
    gallery = galleryState({ data: introPage });
    render(<LessonGrid />);

    typeQuery("rust");

    const intro = screen.getByText("Intro");
    expect(intro.closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    expect(intro.closest("[aria-busy]")).toHaveClass("opacity-50");
    expect(screen.getByRole("status")).toHaveTextContent("Searching…");
  });

  it("keeps the results until Enter is pressed again after editing the query", () => {
    gallery = galleryState({ data: introPage });
    searchState = found;
    render(<LessonGrid />);
    typeQuery("rust");

    fireEvent.change(screen.getByRole("textbox", { name: "Search authors and lessons" }), {
      target: { value: "go" },
    });
    expect(searchedFor.at(-1)).toBe("rust");
    expect(screen.getByText("search results")).toBeInTheDocument();

    fireEvent.submit(screen.getByRole("search"));
    expect(searchedFor.at(-1)).toBe("go");
  });

  it("goes back to the gallery on Escape, or on Enter with an empty field", () => {
    gallery = galleryState({ data: introPage });
    searchState = found;
    render(<LessonGrid />);
    const field = () => screen.getByRole("textbox", { name: "Search authors and lessons" });

    typeQuery("rust");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field()).toHaveValue("");
    expect(screen.getByText("Intro")).toBeInTheDocument();

    typeQuery("rust");
    typeQuery("  ");
    expect(screen.getByText("Intro")).toBeInTheDocument();
  });

  it("ignores the Enter that ends an input method's composition", () => {
    gallery = galleryState({ data: introPage });
    searchState = found;
    render(<LessonGrid />);
    const field = screen.getByRole("textbox", { name: "Search authors and lessons" });
    fireEvent.change(field, { target: { value: "rust" } });

    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
    fireEvent.submit(screen.getByRole("search"));
    expect(screen.queryByText("search results")).not.toBeInTheDocument();

    fireEvent.keyDown(field, { key: "Enter", keyCode: 13 });
    fireEvent.submit(screen.getByRole("search"));
    expect(screen.getByText("search results")).toBeInTheDocument();
  });
});

describe("LessonGrid virtual list offset", () => {
  it("measures the list's distance from the page top once page 0 lands after mount", () => {
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(240);
    gallery = galleryState({ isPending: true });
    const view = render(<LessonGrid />);

    gallery = galleryState({
      data: { pages: [{ lessons: [{ slug: "intro", title: "Intro" }], nextPage: null }] },
    });
    scrollMargins.length = 0;
    view.rerender(<LessonGrid />);

    expect(screen.getByText("Intro")).toBeInTheDocument();
    expect(scrollMargins.at(-1)).toBe(240);
  });
});

describe("LessonGrid first-row thumbnails", () => {
  const introPage = { pages: [{ lessons: [{ slug: "intro", title: "Intro" }], nextPage: null }] };

  it("waits on the first row's thumbnails once page 0 has lessons", () => {
    gallery = galleryState({ isPending: true });
    const view = render(<LessonGrid />);
    expect(firstRow.settleWithout).not.toHaveBeenCalled();

    gallery = galleryState({ data: introPage });
    view.rerender(<LessonGrid />);

    const observedRow = firstRow.observe.mock.calls.find(([row]) => row)?.[0];
    expect(observedRow).toHaveTextContent("Intro");
    expect(firstRow.settleWithout).not.toHaveBeenCalled();
  });

  it.each([
    ["page 0 is empty", { data: { pages: [{ lessons: [], nextPage: null }] } }],
    ["page 0 failed", { isError: true, error: new Error("Request failed") }],
  ])("has nothing to wait for when %s", (_case, state) => {
    gallery = galleryState(state);
    render(<LessonGrid />);

    expect(firstRow.settleWithout).toHaveBeenCalled();
    expect(firstRow.observe).not.toHaveBeenCalled();
  });

  it("has nothing to wait for once search results replace the gallery", () => {
    gallery = galleryState({ isPending: true });
    searchState = { isPending: false, isError: false, data: { authors: [], lessons: [] } };
    render(<LessonGrid />);

    typeQuery("rust");

    expect(firstRow.settleWithout).toHaveBeenCalled();
  });

  it("keeps waiting on the gallery while a search it stays up for is still loading", () => {
    gallery = galleryState({ isPending: true });
    render(<LessonGrid />);

    typeQuery("rust");

    expect(firstRow.settleWithout).not.toHaveBeenCalled();
  });
});
