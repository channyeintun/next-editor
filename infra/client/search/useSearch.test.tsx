import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { lessonKeys } from "../../lessons/queryKeys";
import type { Lesson } from "../../lessons/types";
import type { SearchPage } from "./searchApi";

const search = vi.hoisted(() => vi.fn<(q: string, page: number) => Promise<SearchPage>>());

vi.mock("./searchApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./searchApi")>()),
  search: (q: string, page: number) => search(q, page),
}));

const { useSearch } = await import("./useSearch");

function lesson(slug: string): Lesson {
  return {
    slug,
    title: slug,
    description: "",
    thumbnail: `lessons/${slug}/thumb.webp`,
    ne: `lessons/${slug}/lesson.ne`,
  };
}

function page(lessons: Lesson[], overrides: Partial<SearchPage> = {}): SearchPage {
  return {
    authors: [],
    playlists: [],
    lessons,
    lessonTotal: lessons.length,
    nextPage: null,
    ...overrides,
  };
}

function renderSearch(q: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderHook((props: { q: string }) => useSearch(props.q), {
    initialProps: { q },
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  return { ...view, queryClient };
}

describe("useSearch", () => {
  // A lesson opened from the results should resolve from cache instead of a
  // second request for the row the search already returned.
  it("seeds each result's lesson detail query", async () => {
    search.mockResolvedValue(page([lesson("ownership"), lesson("borrowing")]));

    const { result, queryClient } = renderSearch("rust");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.lessons.map((l) => l.slug)).toEqual(["ownership", "borrowing"]);
    expect(search).toHaveBeenCalledWith("rust", 0);
    expect(queryClient.getQueryData(lessonKeys.detail("ownership"))).toEqual(lesson("ownership"));
    expect(queryClient.getQueryData(lessonKeys.detail("borrowing"))).toEqual(lesson("borrowing"));
  });

  // A newer search must not blank the page while it loads.
  it("keeps the last search's results as placeholder data while the next one loads", async () => {
    search.mockReset();
    search
      .mockResolvedValueOnce(page([lesson("ownership")]))
      .mockImplementationOnce(() => new Promise(() => {}));

    const { result, rerender } = renderSearch("rust");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const rust = result.current.data;

    rerender({ q: "go" });
    await waitFor(() => expect(search).toHaveBeenCalledWith("go", 0));
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.isPending).toBe(false);
    expect(result.current.data).toEqual(rust);
  });

  it("loads the next page of lessons onto the ones shown, each lesson once", async () => {
    search.mockReset();
    const author = { username: "chan", name: "Chan", avatarUrl: null };
    search
      .mockResolvedValueOnce(
        page([lesson("css-43"), lesson("css-42")], {
          authors: [author],
          lessonTotal: 4,
          nextPage: 1,
        }),
      )
      // A lesson published in between pushed css-42 onto page 1 as well.
      .mockResolvedValueOnce(
        page([lesson("css-42"), lesson("css-41"), lesson("css-40")], { lessonTotal: 5 }),
      );

    const { result } = renderSearch("css");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    expect(result.current.data?.pageCount).toBe(1);

    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.data?.pageCount).toBe(2));

    expect(search).toHaveBeenLastCalledWith("css", 1);
    expect(result.current.data).toMatchObject({
      authors: [author],
      lessonTotal: 5,
      pageCount: 2,
    });
    expect(result.current.data?.lessons.map((l) => l.slug)).toEqual([
      "css-43",
      "css-42",
      "css-41",
      "css-40",
    ]);
    expect(result.current.hasNextPage).toBe(false);
  });
});
