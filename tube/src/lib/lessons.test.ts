import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import axios from "axios";
import { fetchLessonsPage, findLessonBySlug, flattenLessonPages } from "./lessons";

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

describe("fetchLessonsPage", () => {
  it("starts at the newest d1 page and leaves the seed out while older pages remain", async () => {
    mockedGet.mockResolvedValueOnce(
      jsonResponse({ lessons: [{ slug: "newest-lesson" }], nextPage: 1 }),
    );
    const page = await fetchLessonsPage("d1:0");
    expect(mockedGet).toHaveBeenCalledWith("/api/lessons?page=0", { timeout: 15_000 });
    expect(page.lessons.map((l) => l.slug)).toEqual(["newest-lesson"]);
    expect(page.nextPage).toBe("d1:1");
  });

  it("appends the seed after the oldest d1 lessons on the last page", async () => {
    mockedGet.mockResolvedValueOnce(
      jsonResponse({ lessons: [{ slug: "oldest-lesson" }], nextPage: null }),
    );
    const page = await fetchLessonsPage("d1:3");
    expect(page.lessons.map((l) => l.slug)).toEqual(["oldest-lesson", "introduction"]);
    expect(page.nextPage).toBeNull();
  });

  it("shows the seed alone when d1 has no published lessons", async () => {
    mockedGet.mockResolvedValueOnce(jsonResponse({ lessons: [], nextPage: null }));
    const page = await fetchLessonsPage("d1:0");
    expect(page.lessons.map((l) => l.slug)).toEqual(["introduction"]);
    expect(page.nextPage).toBeNull();
  });

  it("paginates within d1 using d1:n cursors", async () => {
    mockedGet.mockResolvedValueOnce(
      jsonResponse({ lessons: [{ slug: "user-lesson" }], nextPage: 2 }),
    );
    const page = await fetchLessonsPage("d1:1");
    expect(mockedGet).toHaveBeenCalledWith("/api/lessons?page=1", { timeout: 15_000 });
    expect(page.nextPage).toBe("d1:2");
  });

  // Without a timeout a stalled-but-accepted request never settles, so Query's
  // retry never fires and the grid sits in isFetchingNextPage showing skeletons
  // with no error row to recover from.
  it("bounds the page request with a timeout so a stalled fetch reaches the retry UI", async () => {
    mockedGet.mockResolvedValueOnce(jsonResponse({ lessons: [], nextPage: null }));
    await fetchLessonsPage("d1:0");
    const config = mockedGet.mock.calls[0][1];
    expect(config?.timeout, "page fetch must carry an explicit timeout").toBeGreaterThan(0);
  });

  it("terminates once d1 reports nextPage null", async () => {
    mockedGet.mockResolvedValueOnce(jsonResponse({ lessons: [], nextPage: null }));
    const page = await fetchLessonsPage("d1:3");
    expect(page.nextPage).toBeNull();
  });

  it("treats a d1 SPA fallback (200 + text/html) as an empty last page instead of crashing", async () => {
    mockedGet.mockResolvedValueOnce(htmlFallbackResponse());
    const page = await fetchLessonsPage("d1:0");
    expect(page.lessons.map((l) => l.slug)).toEqual(["introduction"]);
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

describe("flattenLessonPages", () => {
  const lesson = (slug: string) => ({ slug, title: slug, description: "", thumbnail: "", ne: "" });
  const page = (slugs: string[]) => ({ lessons: slugs.map(lesson), nextPage: null });

  it("keeps the loaded order and every distinct lesson", () => {
    const flat = flattenLessonPages([page(["a", "b"]), page(["c"])]);
    expect(flat.map((l) => l.slug)).toEqual(["a", "b", "c"]);
  });

  it("renders a lesson once when it lands on both sides of a page boundary", () => {
    // A publish between two page fetches shifts every later row down one, so
    // the boundary row is genuinely returned twice. No ORDER BY can prevent
    // that; the grid keys cards by slug, so it must not reach the render.
    const flat = flattenLessonPages([page(["a", "b", "c"]), page(["c", "d"])]);
    expect(flat.map((l) => l.slug)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the first copy of a slug that appears on two pages", () => {
    const first = { ...lesson("a"), title: "First copy" };
    const second = { ...lesson("a"), title: "Second copy" };
    const flat = flattenLessonPages([
      { lessons: [first], nextPage: "d1:1" },
      { lessons: [second], nextPage: null },
    ]);
    expect(flat).toHaveLength(1);
    expect(flat[0].title).toBe("First copy");
  });

  it("handles no pages at all", () => {
    expect(flattenLessonPages(undefined)).toEqual([]);
    expect(flattenLessonPages([])).toEqual([]);
  });
});
