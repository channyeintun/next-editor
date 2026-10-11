import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { apiClient } from "../apiClient";
import {
  deleteLesson,
  fetchMyLessons,
  publishLesson,
  unpublishLesson,
  updateLessonName,
  updateLessonThumbnail,
} from "./myLessonsApi";

vi.mock("../apiClient", () => ({
  apiClient: {
    get: vi.fn<(url: string) => Promise<{ data: unknown }>>(),
    post: vi.fn<(url: string) => Promise<{ data: unknown }>>(),
    put: vi.fn<(url: string, body: unknown, config?: unknown) => Promise<{ data: unknown }>>(),
    patch: vi.fn<(url: string, body?: unknown) => Promise<{ data: unknown }>>(),
    delete: vi.fn<(url: string) => Promise<{ data: unknown }>>(),
  },
}));

const mockedGet = vi.mocked(apiClient.get);
const mockedPost = vi.mocked(apiClient.post);
const mockedPut = vi.mocked(apiClient.put);
const mockedPatch = vi.mocked(apiClient.patch);
const mockedDelete = vi.mocked(apiClient.delete);

beforeEach(() => {
  mockedGet.mockReset();
  mockedPost.mockReset();
  mockedPut.mockReset();
  mockedPatch.mockReset();
  mockedDelete.mockReset();
});

describe("fetchMyLessons", () => {
  it("returns the owner's lessons from /lessons/mine", async () => {
    const lessons = [{ id: "lesson-1", status: "draft" }];
    mockedGet.mockResolvedValueOnce({ data: { lessons } });

    await expect(fetchMyLessons()).resolves.toEqual(lessons);
    expect(mockedGet).toHaveBeenCalledWith("/lessons/mine");
  });
});

describe("publishLesson", () => {
  it("posts to the publish endpoint", async () => {
    mockedPost.mockResolvedValueOnce({ data: {} });

    await publishLesson("lesson-1");

    expect(mockedPost).toHaveBeenCalledWith("/lessons/lesson-1/publish");
  });
});

describe("unpublishLesson", () => {
  it("posts to the unpublish endpoint", async () => {
    mockedPost.mockResolvedValueOnce({ data: {} });

    await unpublishLesson("lesson-1");

    expect(mockedPost).toHaveBeenCalledWith("/lessons/lesson-1/unpublish");
  });
});

describe("deleteLesson", () => {
  it("deletes the lesson by id", async () => {
    mockedDelete.mockResolvedValueOnce({ data: {} });

    await deleteLesson("lesson-1");

    expect(mockedDelete).toHaveBeenCalledWith("/lessons/lesson-1");
  });
});

describe("updateLessonName", () => {
  it("patches the lesson's title", async () => {
    mockedPatch.mockResolvedValueOnce({ data: {} });

    await updateLessonName("lesson-1", "Ownership");

    expect(mockedPatch).toHaveBeenCalledWith("/lessons/lesson-1", { title: "Ownership" });
  });
});

describe("updateLessonThumbnail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PUTs the new image under a timestamped name, then points the lesson at it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_791_222_405_295);
    mockedPut.mockResolvedValueOnce({ data: { path: "media/lessons/l1/new.webp" } });
    mockedPatch.mockResolvedValueOnce({ data: {} });

    const thumbnail = new File(["webp"], "cover.webp", { type: "image/webp" });
    await updateLessonThumbnail("l1", thumbnail);

    expect(mockedPut).toHaveBeenCalledWith(
      "/uploads/l1/media/l1-thumbnail-1791222405295.webp",
      thumbnail,
      expect.objectContaining({ headers: { "Content-Type": "image/webp" } }),
    );
    expect(mockedPatch).toHaveBeenCalledWith("/lessons/l1", {
      thumbnail: "media/lessons/l1/new.webp",
    });
  });

  it("points the lesson at the default thumbnail without uploading anything", async () => {
    mockedPatch.mockResolvedValueOnce({ data: {} });

    await updateLessonThumbnail("l1", "default");

    expect(mockedPut).not.toHaveBeenCalled();
    expect(mockedPatch).toHaveBeenCalledWith("/lessons/l1", {
      thumbnail: "default-thumbnail.webp",
    });
  });
});
