import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { apiClient } from "../apiClient";
import { deleteLessonAudioFile } from "./deleteMediaFile";

vi.mock("../apiClient", () => ({
  apiClient: {
    delete: vi.fn<(url: string) => Promise<{ data: unknown }>>(),
  },
}));

const mockedDelete = vi.mocked(apiClient.delete);

beforeEach(() => {
  mockedDelete.mockReset();
});

describe("deleteLessonAudioFile", () => {
  it("deletes the file from the lesson's media folder", async () => {
    mockedDelete.mockResolvedValueOnce({ data: "" });

    await deleteLessonAudioFile("lesson-1", "lesson-1-0123abcd.ogg");

    expect(mockedDelete).toHaveBeenCalledWith("/uploads/lesson-1/media/lesson-1-0123abcd.ogg");
  });

  it("passes a refusal on to the caller", async () => {
    mockedDelete.mockRejectedValueOnce(new Error("Request failed with status code 403"));

    await expect(deleteLessonAudioFile("lesson-1", "lesson-1.ogg")).rejects.toThrow("403");
  });
});
