import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "@app/core/src";
import { apiClient } from "../apiClient";
import { formatDuration, uploadLesson } from "./uploadLesson";

vi.mock("../apiClient", () => ({
  apiClient: {
    put: vi.fn<(url: string, body: unknown, config?: unknown) => Promise<{ data: unknown }>>(),
    post: vi.fn<(url: string, body?: unknown) => Promise<{ data: unknown }>>(),
  },
}));

const mockedPut = vi.mocked(apiClient.put);
const mockedPost = vi.mocked(apiClient.post);

function createRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    version: 4,
    id: "recording-1",
    name: "Upload test recording",
    createdAt: 1_700_000_000_000,
    duration: 150_000, // 2:30
    keyframeInterval: 120,
    frames: [
      {
        isKeyframe: true,
        timestamp: 0,
        state: {
          content: "hello",
          position: { lineNumber: 1, column: 1 },
          selection: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 1,
            selectionStartLineNumber: 1,
            selectionStartColumn: 1,
            positionLineNumber: 1,
            positionColumn: 1,
          },
          viewState: null,
        },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  mockedPut.mockReset();
  mockedPost.mockReset();
});

// jsdom's Blob has no .text(); FileReader is the portable way to read it here.
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsText(blob);
  });
}

describe("formatDuration", () => {
  it("formats whole minutes and seconds with zero-padding", () => {
    expect(formatDuration(150_000)).toBe("2:30");
    expect(formatDuration(5_000)).toBe("0:05");
    expect(formatDuration(0)).toBe("0:00");
  });
});

describe("uploadLesson", () => {
  it("uploads only the .ne file for a recording with no media, then creates the draft", async () => {
    mockedPut.mockImplementationOnce((_url, body, config) => {
      const size = (body as Blob).size;
      (config as { onUploadProgress?: (event: { loaded: number }) => void }).onUploadProgress?.({
        loaded: size,
      });
      return Promise.resolve({
        data: { path: "lessons/lesson-1/lesson-1.ne" },
      });
    });
    mockedPost.mockResolvedValueOnce({
      data: { id: "lesson-1", slug: "test-lesson-1" },
    });

    const progressValues: number[] = [];
    const result = await uploadLesson(
      "lesson-1",
      {
        recording: createRecording(),
        title: "My Lesson",
        description: "",
        tags: [],
      },
      (p) => progressValues.push(p),
    );

    expect(mockedPut).toHaveBeenCalledTimes(1);
    expect(mockedPut).toHaveBeenCalledWith(
      "/uploads/lesson-1/media/lesson-1.ne",
      expect.anything(),
      expect.objectContaining({
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
    expect(mockedPost).toHaveBeenCalledWith(
      "/lessons",
      expect.objectContaining({
        id: "lesson-1",
        title: "My Lesson",
        description: undefined,
        tags: undefined,
        duration: "2:30",
        ne: "lessons/lesson-1/lesson-1.ne",
      }),
    );
    expect(result).toEqual({ id: "lesson-1", slug: "test-lesson-1" });
    // onProgress(0) at the start, at least one more update after the upload.
    expect(progressValues[0]).toBe(0);
    expect(progressValues.at(-1)).toBeGreaterThan(0);
  });

  it("uploads audio and camera as separate sibling files when present", async () => {
    const audioBlob = new Blob(["audio-bytes"], { type: "audio/ogg" });
    const cameraBlob = new Blob(["camera-bytes"], { type: "video/webm" });
    mockedPut.mockImplementation((url) => {
      if (typeof url === "string" && url.includes(".ne")) {
        return Promise.resolve({
          data: { path: "lessons/lesson-2/lesson-2.ne" },
        });
      }
      if (typeof url === "string" && url.endsWith(".ogg")) {
        return Promise.resolve({
          data: { path: "lessons/lesson-2/lesson-2.ogg" },
        });
      }
      return Promise.resolve({
        data: { path: "lessons/lesson-2/lesson-2.webm" },
      });
    });
    mockedPost.mockResolvedValueOnce({
      data: { id: "lesson-2", slug: "test-lesson-2" },
    });

    await uploadLesson(
      "lesson-2",
      {
        recording: createRecording({ audioBlob, cameraBlob }),
        title: "With Media",
        description: "desc",
        tags: ["intro", "basics"],
      },
      () => {},
    );

    expect(mockedPut).toHaveBeenCalledTimes(3);
    const uploadedUrls = mockedPut.mock.calls.map((call) => call[0]);
    expect(uploadedUrls).toEqual([
      "/uploads/lesson-2/media/lesson-2.ne",
      "/uploads/lesson-2/media/lesson-2.ogg",
      "/uploads/lesson-2/media/lesson-2.webm",
    ]);
    expect(mockedPost).toHaveBeenCalledWith(
      "/lessons",
      expect.objectContaining({
        tags: ["intro", "basics"],
        description: "desc",
      }),
    );
  });

  it("uploads captions as sibling <id>.<lang>.vtt files, canonicalized to WebVTT", async () => {
    const putBodies: unknown[] = [];
    mockedPut.mockImplementation((url, body) => {
      putBodies.push(body);
      const filename = (url as string).split("/").pop();
      return Promise.resolve({
        data: { path: `lessons/lesson-4/${filename}` },
      });
    });
    mockedPost.mockResolvedValueOnce({
      data: { id: "lesson-4", slug: "test-lesson-4" },
    });

    await uploadLesson(
      "lesson-4",
      {
        recording: createRecording(),
        title: "With captions",
        description: "",
        tags: [],
        captions: [
          { language: "en", cues: [{ start: 0, end: 1000, text: "Hello" }] },
          // Uppercase tags normalize into the filename; last-in wins per language.
          { language: "MY", cues: [{ start: 0, end: 1000, text: "old" }] },
          {
            language: "my",
            cues: [{ start: 0, end: 1000, text: "မင်္ဂလာပါ" }],
          },
        ],
      },
      () => {},
    );

    const uploadedUrls = mockedPut.mock.calls.map((call) => call[0]);
    expect(uploadedUrls).toEqual([
      "/uploads/lesson-4/media/lesson-4.ne",
      "/uploads/lesson-4/media/lesson-4.en.vtt",
      "/uploads/lesson-4/media/lesson-4.my.vtt",
    ]);

    const englishVtt = putBodies[1] as Blob;
    expect(englishVtt.type).toBe("text/vtt");
    expect(await blobText(englishVtt)).toContain("WEBVTT");
    expect(await blobText(putBodies[2] as Blob)).toContain("မင်္ဂလာပါ");
  });

  it("propagates an upload failure without creating the draft", async () => {
    mockedPut.mockRejectedValueOnce(new Error("network error"));

    await expect(
      uploadLesson(
        "lesson-3",
        {
          recording: createRecording(),
          title: "Fails",
          description: "",
          tags: [],
        },
        () => {},
      ),
    ).rejects.toThrow("network error");

    expect(mockedPost).not.toHaveBeenCalled();
  });
});
