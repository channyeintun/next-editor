import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "@app/core/src";
import { decompressBinaryToRecording } from "@app/storage/recordingCodecClient";
import { sha256Hex } from "@app/shared/sha256Hex";
import { apiClient } from "../apiClient";
import { LessonReplaceError, replaceLessonMedia } from "./replaceLessonMedia";

vi.mock("../apiClient", () => ({
  apiClient: {
    put: vi.fn<(url: string, body: unknown, config?: unknown) => Promise<{ data: unknown }>>(),
    patch: vi.fn<(url: string, body?: unknown) => Promise<{ data: unknown }>>(),
    delete: vi.fn<(url: string) => Promise<{ data: unknown }>>(),
  },
}));

const mockedPut = vi.mocked(apiClient.put);
const mockedPatch = vi.mocked(apiClient.patch);
const mockedDelete = vi.mocked(apiClient.delete);

function createRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    version: 4,
    id: "1700000000000",
    name: "Replacement",
    createdAt: 1_700_000_000_000,
    duration: 95_000, // 1:35
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
    audioBlob: new Blob(["new narration"], { type: "audio/ogg" }),
    ...overrides,
  };
}

const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  mockedPut.mockReset();
  mockedPatch.mockReset();
  mockedDelete.mockReset();
  mockedPut.mockImplementation((url: string) => {
    calls.push(`PUT ${url}`);
    return Promise.resolve({ data: { path: url.replace("/uploads/", "lessons/") } });
  });
  mockedPatch.mockImplementation((url: string, body?: unknown) => {
    calls.push(`PATCH ${url} ${JSON.stringify(body)}`);
    return Promise.resolve({ data: {} });
  });
  mockedDelete.mockImplementation((url: string) => {
    calls.push(`DELETE ${url}`);
    return Promise.resolve({ data: "" });
  });
});

describe("replaceLessonMedia", () => {
  it("puts the narration, then the .ne that names it, then the duration, then deletes the old narration", async () => {
    const recording = createRecording();
    const sha8 = (await sha256Hex("new narration")).slice(0, 8);
    const audioFile = `lesson-1-${sha8}.ogg`;

    const result = await replaceLessonMedia({
      lessonId: "lesson-1",
      recording,
      previousAudioFile: "lesson-1.ogg",
    });

    expect(calls).toEqual([
      `PUT /uploads/lesson-1/media/${audioFile}`,
      "PUT /uploads/lesson-1/media/lesson-1.ne",
      'PATCH /lessons/lesson-1 {"duration":"1:35"}',
      "DELETE /uploads/lesson-1/media/lesson-1.ogg",
    ]);
    expect(result).toEqual({ audioFile, removedAudioFile: "lesson-1.ogg", duration: "1:35" });

    // The .ne that went up names the new narration and carries the recording's id.
    const neBody = mockedPut.mock.calls[1][1] as Blob;
    const decoded = await decompressBinaryToRecording(new Uint8Array(await neBody.arrayBuffer()));
    expect(decoded.audioFile).toBe(audioFile);
    expect(decoded.id).toBe("1700000000000");
  });

  it("deletes nothing when the narration's name did not change", async () => {
    const sha8 = (await sha256Hex("new narration")).slice(0, 8);

    const result = await replaceLessonMedia({
      lessonId: "lesson-1",
      recording: createRecording(),
      previousAudioFile: `lesson-1-${sha8}.ogg`,
    });

    expect(mockedDelete).not.toHaveBeenCalled();
    expect(result.removedAudioFile).toBeNull();
  });

  it("still reports the replacement when deleting the old narration fails", async () => {
    mockedDelete.mockRejectedValueOnce(new Error("Request failed with status code 500"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await replaceLessonMedia({
      lessonId: "lesson-1",
      recording: createRecording(),
      previousAudioFile: "lesson-1.ogg",
    });

    expect(result.removedAudioFile).toBeNull();
    expect(result.audioFile).toMatch(/^lesson-1-[0-9a-f]{8}\.ogg$/);
    warn.mockRestore();
  });

  it("stops on a failed .ne PUT and says the narration was already put", async () => {
    mockedPut
      .mockImplementationOnce(() => Promise.resolve({ data: { path: "lessons/lesson-1/a.ogg" } }))
      .mockImplementationOnce(() => Promise.reject(new Error("Network Error")));

    const failure = await replaceLessonMedia({
      lessonId: "lesson-1",
      recording: createRecording(),
      previousAudioFile: "lesson-1.ogg",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LessonReplaceError);
    const error = failure as LessonReplaceError;
    expect(error.message).toBe("Putting the lesson file lesson-1.ne failed");
    expect(error.done).toHaveLength(1);
    expect(error.done[0]).toMatch(/^put the new narration lesson-1-[0-9a-f]{8}\.ogg/);
    expect(mockedPatch).not.toHaveBeenCalled();
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("refuses a recording with no narration before any request", async () => {
    await expect(
      replaceLessonMedia({
        lessonId: "lesson-1",
        recording: createRecording({ audioBlob: undefined }),
        previousAudioFile: "lesson-1.ogg",
      }),
    ).rejects.toThrow("no narration");
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it("reports progress across the two files", async () => {
    const progress: number[] = [];
    await replaceLessonMedia({
      lessonId: "lesson-1",
      recording: createRecording(),
      previousAudioFile: null,
      onProgress: (fraction) => progress.push(fraction),
    });
    expect(progress[0]).toBe(0);
    expect(mockedDelete).not.toHaveBeenCalled();
  });
});
