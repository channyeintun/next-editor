import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import axios from "axios";
import type { GalleryItem } from "../types";
import { fetchGalleryPage, findLessonBySlug, flattenGalleryPages } from "./lessons";

vi.mock("axios", () => {
  const get =
    vi.fn<
      (
        url: string,
        config?: { timeout?: number },
      ) => Promise<{ data: unknown; headers: Record<string, unknown> }>
    >();
  return {
    default: {
      get,
      // apiClient (which owns the 404 rule) builds its instance at import.
      create: () => ({}),
      isAxiosError: (err: unknown): boolean =>
        typeof err === "object" && err !== null && "isAxiosError" in err,
    },
  };
});

function axiosError(status: number) {
  return { isAxiosError: true, response: { status } };
}

function jsonResponse(data: unknown) {
  return { data, headers: { "content-type": "application/json" } };
}

function htmlFallbackResponse() {
  return { data: "<!doctype html>...", headers: { "content-type": "text/html" } };
}

const mockedGet = vi.mocked(axios.get);

beforeEach(() => {
  mockedGet.mockReset();
});

/** A card's slug, marked when the card is a playlist. */
function cardSlugs(items: readonly GalleryItem[]): string[] {
  return items.map((item) =>
    item.kind === "lesson" ? item.lesson.slug : `playlist:${item.playlist.slug}`,
  );
}

const lessonCard = (slug: string) => ({ kind: "lesson", lesson: { slug } });
const playlistCard = (slug: string) => ({ kind: "playlist", playlist: { slug } });

describe("fetchGalleryPage", () => {
  it("starts at the newest d1 page and leaves the seed out while older pages remain", async () => {
    mockedGet.mockResolvedValueOnce(
      jsonResponse({ items: [playlistCard("rust"), lessonCard("newest-lesson")], nextPage: 1 }),
    );
    const page = await fetchGalleryPage("d1:0");
    expect(mockedGet).toHaveBeenCalledWith("/api/gallery?page=0", { timeout: 15_000 });
    expect(cardSlugs(page.items)).toEqual(["playlist:rust", "newest-lesson"]);
    expect(page.nextPage).toBe("d1:1");
  });

  it("appends the seed after the oldest d1 cards on the last page", async () => {
    mockedGet.mockResolvedValueOnce(
      jsonResponse({ items: [lessonCard("oldest-lesson")], nextPage: null }),
    );
    const page = await fetchGalleryPage("d1:3");
    expect(cardSlugs(page.items)).toEqual(["oldest-lesson", "introduction"]);
    expect(page.nextPage).toBeNull();
  });

  it("shows the seed alone when d1 has no published lessons", async () => {
    mockedGet.mockResolvedValueOnce(jsonResponse({ items: [], nextPage: null }));
    const page = await fetchGalleryPage("d1:0");
    expect(cardSlugs(page.items)).toEqual(["introduction"]);
    expect(page.nextPage).toBeNull();
  });

  it("paginates within d1 using d1:n cursors", async () => {
    mockedGet.mockResolvedValueOnce(
      jsonResponse({ items: [lessonCard("user-lesson")], nextPage: 2 }),
    );
    const page = await fetchGalleryPage("d1:1");
    expect(mockedGet).toHaveBeenCalledWith("/api/gallery?page=1", { timeout: 15_000 });
    expect(page.nextPage).toBe("d1:2");
  });

  // Without a timeout a stalled-but-accepted request never settles, so Query's
  // retry never fires and the grid sits in isFetchingNextPage showing skeletons
  // with no error row to recover from.
  it("bounds the page request with a timeout so a stalled fetch reaches the retry UI", async () => {
    mockedGet.mockResolvedValueOnce(jsonResponse({ items: [], nextPage: null }));
    await fetchGalleryPage("d1:0");
    const config = mockedGet.mock.calls[0][1];
    expect(config?.timeout, "page fetch must carry an explicit timeout").toBeGreaterThan(0);
  });

  it("terminates once d1 reports nextPage null", async () => {
    mockedGet.mockResolvedValueOnce(jsonResponse({ items: [], nextPage: null }));
    const page = await fetchGalleryPage("d1:3");
    expect(page.nextPage).toBeNull();
  });

  it("treats a d1 SPA fallback (200 + text/html) as an empty last page instead of crashing", async () => {
    mockedGet.mockResolvedValueOnce(htmlFallbackResponse());
    const page = await fetchGalleryPage("d1:0");
    expect(cardSlugs(page.items)).toEqual(["introduction"]);
    expect(page.nextPage).toBeNull();
  });
});

describe("findLessonBySlug", () => {
  it("returns the seed lesson when the local JSON matches without fetching", async () => {
    const lesson = await findLessonBySlug("introduction");
    expect(mockedGet).not.toHaveBeenCalled();
    expect(lesson?.slug).toBe("introduction");
  });

  it("falls through to D1 when the local JSON does not match", async () => {
    mockedGet.mockResolvedValueOnce(jsonResponse({ slug: "user-lesson" }));
    const lesson = await findLessonBySlug("user-lesson");
    expect(mockedGet).toHaveBeenCalledWith("/api/lessons/user-lesson", { timeout: 15_000 });
    expect(lesson?.slug).toBe("user-lesson");
  });

  it("bounds the slug lookup with a timeout too", async () => {
    mockedGet.mockResolvedValueOnce(jsonResponse({ slug: "user-lesson" }));
    await findLessonBySlug("user-lesson");
    const config = mockedGet.mock.calls[0][1];
    expect(config?.timeout, "slug lookup must carry an explicit timeout").toBeGreaterThan(0);
  });

  it("returns null when neither local JSON nor D1 has the slug", async () => {
    mockedGet.mockRejectedValueOnce(axiosError(404));
    const lesson = await findLessonBySlug("nope");
    expect(lesson).toBeNull();
  });

  it("returns null when both the local JSON does not match and the D1 lookup 200 as HTML (dev without dev:worker)", async () => {
    mockedGet.mockResolvedValueOnce(htmlFallbackResponse());
    const lesson = await findLessonBySlug("nope");
    expect(lesson).toBeNull();
  });
});

describe("flattenGalleryPages", () => {
  const lesson = (slug: string): GalleryItem => ({
    kind: "lesson",
    lesson: { slug, title: slug, description: "", thumbnail: "", ne: "" },
  });
  const playlist = (slug: string): GalleryItem => ({
    kind: "playlist",
    playlist: { slug, title: slug, description: "", lessonCount: 1, thumbnail: null },
  });
  const page = (items: GalleryItem[]) => ({ items, nextPage: null });

  it("keeps the loaded order and every distinct card", () => {
    const flat = flattenGalleryPages([page([playlist("rust"), lesson("a")]), page([lesson("b")])]);
    expect(cardSlugs(flat)).toEqual(["playlist:rust", "a", "b"]);
  });

  it("renders a card once when it lands on both sides of a page boundary", () => {
    // A publish between two page fetches shifts every later row down one, so
    // the boundary row is genuinely returned twice. No ORDER BY can prevent
    // that; the grid keys cards by slug, so it must not reach the render.
    const flat = flattenGalleryPages([
      page([lesson("a"), playlist("rust"), lesson("c")]),
      page([lesson("c"), playlist("rust"), lesson("d")]),
    ]);
    expect(cardSlugs(flat)).toEqual(["a", "playlist:rust", "c", "d"]);
  });

  it("keeps a lesson and a playlist that share a slug", () => {
    const flat = flattenGalleryPages([page([playlist("rust"), lesson("rust")])]);
    expect(cardSlugs(flat)).toEqual(["playlist:rust", "rust"]);
  });

  it("keeps the first copy of a card that appears on two pages", () => {
    const first: GalleryItem = {
      kind: "lesson",
      lesson: { ...lessonOf("a"), title: "First copy" },
    };
    const second: GalleryItem = {
      kind: "lesson",
      lesson: { ...lessonOf("a"), title: "Second copy" },
    };
    const flat = flattenGalleryPages([
      { items: [first], nextPage: "d1:1" },
      { items: [second], nextPage: null },
    ]);
    expect(flat).toEqual([first]);
  });

  it("handles no pages at all", () => {
    expect(flattenGalleryPages(undefined)).toEqual([]);
    expect(flattenGalleryPages([])).toEqual([]);
  });
});

function lessonOf(slug: string) {
  return { slug, title: slug, description: "", thumbnail: "", ne: "" };
}
