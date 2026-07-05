import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../apiClient";
import { deleteLesson, fetchMyLessons, unpublishLesson } from "./myLessonsApi";

vi.mock("../apiClient", () => ({
  apiClient: {
    get: vi.fn<(url: string) => Promise<{ data: unknown }>>(),
    post: vi.fn<(url: string) => Promise<{ data: unknown }>>(),
    delete: vi.fn<(url: string) => Promise<{ data: unknown }>>(),
  },
}));

const mockedGet = vi.mocked(apiClient.get);
const mockedPost = vi.mocked(apiClient.post);
const mockedDelete = vi.mocked(apiClient.delete);

beforeEach(() => {
  mockedGet.mockReset();
  mockedPost.mockReset();
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
