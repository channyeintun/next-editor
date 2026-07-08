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
  it("returns local json data for seed:0 directly without fetching", async () => {
    const page = await fetchLessonsPage("seed:0");
    expect(mockedGet).not.toHaveBeenCalled();
    expect(page.nextPage).toBe("d1:0");
    expect(page.lessons).toHaveLength(1);
    expect(page.lessons[0].slug).toBe("introduction");
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

  it("treats a d1 SPA fallback (200 + text/html) as an empty terminal page instead of crashing", async () => {
    mockedGet.mockResolvedValueOnce(htmlFallbackResponse());
    const page = await fetchLessonsPage("d1:0");
    expect(page.lessons).toEqual([]);
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
    expect(mockedGet).toHaveBeenCalledWith("/api/lessons/user-lesson");
    expect(lesson?.slug).toBe("user-lesson");
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
