import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { lessonKeys } from "../../lessons/queryKeys";
import type { Lesson } from "../../lessons/types";
import type { SearchResults } from "./searchApi";

const search = vi.hoisted(() => vi.fn<(q: string) => Promise<SearchResults>>());

vi.mock("./searchApi", () => ({ search: (q: string) => search(q) }));

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

describe("useSearch", () => {
  // A lesson opened from the results should resolve from cache instead of a
  // second request for the row the search already returned.
  it("seeds each result's lesson detail query", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const results = { authors: [], lessons: [lesson("ownership"), lesson("borrowing")] };
    search.mockResolvedValue(results);

    const { result } = renderHook(() => useSearch("rust"), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toBe(results);
    expect(search).toHaveBeenCalledWith("rust");
    expect(queryClient.getQueryData(lessonKeys.detail("ownership"))).toEqual(lesson("ownership"));
    expect(queryClient.getQueryData(lessonKeys.detail("borrowing"))).toEqual(lesson("borrowing"));
  });

  // A newer search must not blank the page while it loads.
  it("keeps the last search's results as placeholder data while the next one loads", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rust = { authors: [], lessons: [lesson("ownership")] };
    search.mockResolvedValueOnce(rust).mockImplementationOnce(() => new Promise(() => {}));

    const { result, rerender } = renderHook(({ q }) => useSearch(q), {
      initialProps: { q: "rust" },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ q: "go" });
    await waitFor(() => expect(search).toHaveBeenCalledWith("go"));
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.isPending).toBe(false);
    expect(result.current.data).toBe(rust);
  });
});
