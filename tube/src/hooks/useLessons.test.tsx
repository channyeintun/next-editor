import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Lesson } from "../types";

const fetchLessonsPage = vi.fn<(cursor: string) => Promise<unknown>>();
const findLessonBySlug = vi.fn<(slug: string) => Promise<Lesson | null>>();

vi.mock("../lib/lessons", () => ({
  fetchLessonsPage: (cursor: string) => fetchLessonsPage(cursor),
  findLessonBySlug: (slug: string) => findLessonBySlug(slug),
}));

const { lessonDetailQueryKey, useLesson, useLessonsInfinite } = await import("./useLessons");

function lesson(slug: string): Lesson {
  return {
    slug,
    title: slug,
    description: "",
    thumbnail: `lessons/${slug}/thumb.webp`,
    ne: `lessons/${slug}/lesson.ne`,
  };
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("lesson detail cache seeding", () => {
  it("serves a detail query from the gallery page that already carried it", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchLessonsPage.mockResolvedValue({ lessons: [lesson("a"), lesson("b")], nextPage: null });

    const gallery = renderHook(() => useLessonsInfinite(), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(gallery.result.current.isSuccess).toBe(true));

    // Rendering the detail route for a card in that list must not fetch: the
    // row is already in the cache under the detail key.
    const detail = renderHook(() => useLesson("b"), { wrapper: wrapper(queryClient) });

    expect(detail.result.current.isPending).toBe(false);
    expect(detail.result.current.data).toEqual(lesson("b"));
    expect(findLessonBySlug).not.toHaveBeenCalled();
  });

  it("still fetches a slug no list has supplied", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    findLessonBySlug.mockResolvedValue(lesson("unseeded"));

    const detail = renderHook(() => useLesson("unseeded"), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(detail.result.current.isSuccess).toBe(true));
    expect(findLessonBySlug).toHaveBeenCalledWith("unseeded");
  });

  it("serves a detail query hydrated from the server render", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // What hydrateServerQueryState() leaves behind on a direct /learn/:slug visit.
    queryClient.setQueryData(lessonDetailQueryKey("ssr"), lesson("ssr"));

    const detail = renderHook(() => useLesson("ssr"), { wrapper: wrapper(queryClient) });

    expect(detail.result.current.isPending).toBe(false);
    expect(detail.result.current.data).toEqual(lesson("ssr"));
    expect(findLessonBySlug).not.toHaveBeenCalled();
  });
});
