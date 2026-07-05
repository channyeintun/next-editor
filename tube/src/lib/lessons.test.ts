import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { fetchLessonsPage, findLessonBySlug } from "./lessons";

vi.mock("axios", () => {
  const get =
    vi.fn<(url: string) => Promise<{ data: unknown; headers: Record<string, unknown> }>>();
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

// A real JSON success response always carries this header in production —
// mocks need it too, since isHtmlFallback() reads it to distinguish a real
// shard from the SPA catch-all (see the "html fallback" tests below, which
// are what actually caught this bug in the first place).
function jsonResponse(data: unknown) {
  return { data, headers: { "content-type": "application/json" } };
}

// The Worker's SPA fallback returns 200 + this content-type for ANY
// unmatched static-asset path — never a real 404. Confirmed against the
// live deployment, not assumed.
function htmlFallbackResponse() {
  return { data: "<!doctype html>...", headers: { "content-type": "text/html" } };
}

const mockedGet = vi.mocked(axios.get);

beforeEach(() => {
  mockedGet.mockReset();
});

describe("fetchLessonsPage", () => {
  it("returns a seed:n cursor while the static seed has more pages", async () => {
    mockedGet.mockResolvedValueOnce(
      jsonResponse({ lessons: [{ slug: "introduction" }], nextPage: 1 }),
    );
    const page = await fetchLessonsPage("seed:0");
    expect(mockedGet).toHaveBeenCalledWith("/lessons/page-0.json");
    expect(page.nextPage).toBe("seed:1");
    expect(page.lessons).toHaveLength(1);
  });

  it("switches to d1:0 once the seed reports nextPage null", async () => {
    mockedGet.mockResolvedValueOnce(
      jsonResponse({ lessons: [{ slug: "introduction" }], nextPage: null }),
    );
    const page = await fetchLessonsPage("seed:0");
    expect(page.nextPage).toBe("d1:0");
  });

  it("falls through to d1:0 when the seed shard itself 404s", async () => {
    mockedGet.mockRejectedValueOnce(axiosError(404));
    mockedGet.mockResolvedValueOnce(jsonResponse({ lessons: [], nextPage: null }));
    const page = await fetchLessonsPage("seed:5");
    expect(mockedGet).toHaveBeenNthCalledWith(1, "/lessons/page-5.json");
    expect(mockedGet).toHaveBeenNthCalledWith(2, "/api/lessons?page=0");
    expect(page.nextPage).toBeNull();
  });

  it("falls through to d1:0 when the missing seed shard returns the SPA fallback (200 + text/html) instead of a 404", async () => {
    // This is what actually happens in production: not_found_handling =
    // "single-page-application" means an out-of-range shard index never
    // 404s, it 200s with index.html.
    mockedGet.mockResolvedValueOnce(htmlFallbackResponse());
    mockedGet.mockResolvedValueOnce(jsonResponse({ lessons: [], nextPage: null }));
    const page = await fetchLessonsPage("seed:5");
    expect(mockedGet).toHaveBeenNthCalledWith(1, "/lessons/page-5.json");
    expect(mockedGet).toHaveBeenNthCalledWith(2, "/api/lessons?page=0");
    expect(page.nextPage).toBeNull();
  });

  it("paginates within d1 using d1:n cursors", async () => {
    mockedGet.mockResolvedValueOnce(
      jsonResponse({ lessons: [{ slug: "user-lesson" }], nextPage: 2 }),
    );
    const page = await fetchLessonsPage("d1:1");
    expect(mockedGet).toHaveBeenCalledWith("/api/lessons?page=1");
    expect(page.nextPage).toBe("d1:2");
  });

  it("terminates once d1 reports nextPage null", async () => {
    mockedGet.mockResolvedValueOnce(jsonResponse({ lessons: [], nextPage: null }));
    const page = await fetchLessonsPage("d1:3");
    expect(page.nextPage).toBeNull();
  });
});

describe("findLessonBySlug", () => {
  it("returns the seed lesson when the seed shard matches", async () => {
    mockedGet.mockResolvedValueOnce(jsonResponse({ slug: "introduction" }));
    const lesson = await findLessonBySlug("introduction");
    expect(mockedGet).toHaveBeenCalledWith("/lessons/by-slug/introduction.json");
    expect(lesson?.slug).toBe("introduction");
  });

  it("falls through to D1 when the seed shard 404s", async () => {
    mockedGet.mockRejectedValueOnce(axiosError(404));
    mockedGet.mockResolvedValueOnce(jsonResponse({ slug: "user-lesson" }));
    const lesson = await findLessonBySlug("user-lesson");
    expect(mockedGet).toHaveBeenNthCalledWith(1, "/lessons/by-slug/user-lesson.json");
    expect(mockedGet).toHaveBeenNthCalledWith(2, "/api/lessons/user-lesson");
    expect(lesson?.slug).toBe("user-lesson");
  });

  it("falls through to D1 when the seed shard returns the SPA fallback (200 + text/html) instead of a 404 -- the real production bug this was written for", async () => {
    // Root cause of a real production incident: every D1-only lesson's
    // by-slug shard doesn't exist as a static asset, so the Worker's SPA
    // catch-all answered 200 with index.html instead of a 404. The old code
    // trusted any 200 as a real Lesson, silently "succeeding" with garbage
    // HTML -- lesson.ne ended up undefined, so the recording URL never even
    // passed the .ne extension check and no fetch was ever attempted at all.
    mockedGet.mockResolvedValueOnce(htmlFallbackResponse());
    mockedGet.mockResolvedValueOnce(
      jsonResponse({ slug: "user-lesson", ne: "media/lessons/x/x.ne" }),
    );
    const lesson = await findLessonBySlug("user-lesson");
    expect(mockedGet).toHaveBeenNthCalledWith(1, "/lessons/by-slug/user-lesson.json");
    expect(mockedGet).toHaveBeenNthCalledWith(2, "/api/lessons/user-lesson");
    expect(lesson?.slug).toBe("user-lesson");
    expect(lesson?.ne).toBe("media/lessons/x/x.ne");
  });

  it("returns null when neither seed nor D1 has the slug", async () => {
    mockedGet.mockRejectedValueOnce(axiosError(404));
    mockedGet.mockRejectedValueOnce(axiosError(404));
    const lesson = await findLessonBySlug("nope");
    expect(lesson).toBeNull();
  });

  it("returns null when the seed shard 200s as HTML and D1 genuinely 404s too", async () => {
    mockedGet.mockResolvedValueOnce(htmlFallbackResponse());
    mockedGet.mockRejectedValueOnce(axiosError(404));
    const lesson = await findLessonBySlug("nope");
    expect(lesson).toBeNull();
  });

  it("rethrows a non-404 error from the seed lookup", async () => {
    mockedGet.mockRejectedValueOnce(axiosError(500));
    await expect(findLessonBySlug("introduction")).rejects.toBeTruthy();
  });
});
