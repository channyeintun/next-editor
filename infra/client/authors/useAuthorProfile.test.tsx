import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { lessonKeys } from "../../lessons/queryKeys";
import type { Lesson } from "../../lessons/types";
import type { AuthorProfile } from "./authorsApi";

const fetchAuthorProfile = vi.hoisted(() =>
  vi.fn<(username: string) => Promise<AuthorProfile | null>>(),
);

vi.mock("./authorsApi", () => ({
  fetchAuthorProfile: (username: string) => fetchAuthorProfile(username),
}));

const { useAuthorProfile } = await import("./useAuthorProfile");

function lesson(slug: string): Lesson {
  return {
    slug,
    title: slug,
    description: "",
    thumbnail: `lessons/${slug}/thumb.webp`,
    ne: `lessons/${slug}/lesson.ne`,
  };
}

function renderProfileHook(queryClient: QueryClient, username: string) {
  return renderHook(() => useAuthorProfile(username), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

describe("useAuthorProfile", () => {
  // A lesson opened from the profile should resolve from cache instead of a
  // second request for the row the profile already returned.
  it("seeds the detail query of each lesson on the profile", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const profile: AuthorProfile = {
      user: { username: "chan", name: "Chan", avatarUrl: null },
      lessons: [lesson("ownership")],
      playlists: [],
    };
    fetchAuthorProfile.mockResolvedValue(profile);

    const { result } = renderProfileHook(queryClient, "chan");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toBe(profile);
    expect(fetchAuthorProfile).toHaveBeenCalledWith("chan");
    expect(queryClient.getQueryData(lessonKeys.detail("ownership"))).toEqual(lesson("ownership"));
  });

  it("still reports an unknown username as null", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchAuthorProfile.mockResolvedValue(null);

    const { result } = renderProfileHook(queryClient, "nobody");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toBeNull();
  });
});
