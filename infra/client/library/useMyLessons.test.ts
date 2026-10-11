import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { describe, expect, it } from "vite-plus/test";
import { invalidateLessonDerivedQueries } from "./useMyLessons";

// The public reads render the same lesson rows an owner's mutation changes and
// keep them fresh for up to a minute, so an unpublished lesson stayed in the
// gallery, its detail page and search results until they aged out.
describe("invalidateLessonDerivedQueries", () => {
  it("marks every query that shows a lesson stale", async () => {
    const queryClient = new QueryClient();
    const keys: QueryKey[] = [
      ["lessons", "mine"],
      ["lessons", "infinite"],
      ["lessons", "detail", "rust-ownership"],
      ["authors", "chan"],
      ["search", "rust"],
      ["playlists", "detail", "rust-from-zero"],
    ];
    for (const queryKey of keys) {
      queryClient.setQueryData(queryKey, {});
    }

    await invalidateLessonDerivedQueries(queryClient);

    for (const queryKey of keys) {
      expect([queryKey, queryClient.getQueryState(queryKey)?.isInvalidated]).toEqual([
        queryKey,
        true,
      ]);
    }
  });

  it("leaves queries that show no lesson alone", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["auth", "google-config"], {});

    await invalidateLessonDerivedQueries(queryClient);

    expect(queryClient.getQueryState(["auth", "google-config"])?.isInvalidated).toBe(false);
  });
});
