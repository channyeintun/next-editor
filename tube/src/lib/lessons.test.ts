import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { fetchLessonsPage, findLessonBySlug } from "./lessons";

vi.mock("axios", () => {
  const get = vi.fn<(url: string) => Promise<{ data: unknown }>>();
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

const mockedGet = vi.mocked(axios.get);

beforeEach(() => {
  mockedGet.mockReset();
});

describe("fetchLessonsPage", () => {
  it("returns a seed:n cursor while the static seed has more pages", async () => {
    mockedGet.mockResolvedValueOnce({
      data: { lessons: [{ slug: "introduction" }], nextPage: 1 },
    });
    const page = await fetchLessonsPage("seed:0");
    expect(mockedGet).toHaveBeenCalledWith("/lessons/page-0.json");
    expect(page.nextPage).toBe("seed:1");
    expect(page.lessons).toHaveLength(1);
  });

  it("switches to d1:0 once the seed reports nextPage null", async () => {
    mockedGet.mockResolvedValueOnce({
      data: { lessons: [{ slug: "introduction" }], nextPage: null },
    });
    const page = await fetchLessonsPage("seed:0");
    expect(page.nextPage).toBe("d1:0");
  });

  it("falls through to d1:0 when the seed shard itself 404s", async () => {
    mockedGet.mockRejectedValueOnce(axiosError(404));
    mockedGet.mockResolvedValueOnce({ data: { lessons: [], nextPage: null } });
    const page = await fetchLessonsPage("seed:5");
    expect(mockedGet).toHaveBeenNthCalledWith(1, "/lessons/page-5.json");
    expect(mockedGet).toHaveBeenNthCalledWith(2, "/api/lessons?page=0");
    expect(page.nextPage).toBeNull();
  });

  it("paginates within d1 using d1:n cursors", async () => {
    mockedGet.mockResolvedValueOnce({
      data: { lessons: [{ slug: "user-lesson" }], nextPage: 2 },
    });
    const page = await fetchLessonsPage("d1:1");
    expect(mockedGet).toHaveBeenCalledWith("/api/lessons?page=1");
    expect(page.nextPage).toBe("d1:2");
  });

  it("terminates once d1 reports nextPage null", async () => {
    mockedGet.mockResolvedValueOnce({ data: { lessons: [], nextPage: null } });
    const page = await fetchLessonsPage("d1:3");
    expect(page.nextPage).toBeNull();
  });
});

describe("findLessonBySlug", () => {
  it("returns the seed lesson when the seed shard matches", async () => {
    mockedGet.mockResolvedValueOnce({ data: { slug: "introduction" } });
    const lesson = await findLessonBySlug("introduction");
    expect(mockedGet).toHaveBeenCalledWith("/lessons/by-slug/introduction.json");
    expect(lesson?.slug).toBe("introduction");
  });

  it("falls through to D1 when the seed shard 404s", async () => {
    mockedGet.mockRejectedValueOnce(axiosError(404));
    mockedGet.mockResolvedValueOnce({ data: { slug: "user-lesson" } });
    const lesson = await findLessonBySlug("user-lesson");
    expect(mockedGet).toHaveBeenNthCalledWith(1, "/lessons/by-slug/user-lesson.json");
    expect(mockedGet).toHaveBeenNthCalledWith(2, "/api/lessons/user-lesson");
    expect(lesson?.slug).toBe("user-lesson");
  });

  it("returns null when neither seed nor D1 has the slug", async () => {
    mockedGet.mockRejectedValueOnce(axiosError(404));
    mockedGet.mockRejectedValueOnce(axiosError(404));
    const lesson = await findLessonBySlug("nope");
    expect(lesson).toBeNull();
  });

  it("rethrows a non-404 error from the seed lookup", async () => {
    mockedGet.mockRejectedValueOnce(axiosError(500));
    await expect(findLessonBySlug("introduction")).rejects.toBeTruthy();
  });
});
