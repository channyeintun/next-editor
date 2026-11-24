import { AxiosError, AxiosHeaders } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { OwnedLesson } from "@next-editor/infra";
import { apiClient } from "../../../infra/client/apiClient";
import type { CaptionCue, Recording } from "../../core/src";
import { decompressBinaryToRecording } from "../../storage/recordingCodecClient";
import { buildRecordingFiles } from "../../storage/recordingExport";
import type { StudioRunArtifacts } from "../runStudioRender";
import {
  compareCaptions,
  findPublishedLesson,
  replacePublishedLesson,
} from "./publishedLessonUpdate";

vi.mock("../../../infra/client/apiClient", () => ({
  apiClient: {
    get: vi.fn<(url: string) => Promise<{ data: unknown }>>(),
    put: vi.fn<(url: string, body: unknown, config?: unknown) => Promise<{ data: unknown }>>(),
    patch: vi.fn<(url: string, body?: unknown) => Promise<{ data: unknown }>>(),
    delete: vi.fn<(url: string) => Promise<{ data: unknown }>>(),
  },
}));

const mockedGet = vi.mocked(apiClient.get);
const mockedPut = vi.mocked(apiClient.put);
const mockedPatch = vi.mocked(apiClient.patch);
const mockedDelete = vi.mocked(apiClient.delete);

function lesson(overrides: Partial<OwnedLesson> = {}): OwnedLesson {
  return {
    id: "lesson-1",
    slug: "go-error-values",
    title: "Go error values",
    description: "",
    thumbnail: "",
    ne: "media/lessons/lesson-1/lesson-1.ne",
    duration: "1:00",
    tags: [],
    status: "published",
    publishedAt: 1,
    ...overrides,
  };
}

function cue(text: string, start: number, end = start + 900): CaptionCue {
  return { text, start, end };
}

function recording(overrides: Partial<Recording> = {}): Recording {
  return {
    version: 4,
    id: "1700000000000",
    name: "lesson",
    createdAt: 1_700_000_000_000,
    duration: 60_000,
    keyframeInterval: 120,
    frames: [
      {
        isKeyframe: true,
        timestamp: 0,
        state: {
          content: "package main",
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

function withCues(cues: CaptionCue[], overrides: Partial<Recording> = {}): Recording {
  return recording({ captions: [{ id: "narration", language: "en", cues }], ...overrides });
}

function unauthorized(): AxiosError {
  return new AxiosError("Request failed with status code 401", "ERR_BAD_REQUEST", undefined, null, {
    status: 401,
    statusText: "Unauthorized",
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: { error: "Unauthorized" },
  });
}

const PUBLISHED_CUES = [cue("Errors are values.", 0), cue("Return them.", 1_000)];

/** The published lesson's `.ne`, as the media route would serve it. */
async function publishedNe(): Promise<Blob> {
  const files = await buildRecordingFiles(
    withCues(PUBLISHED_CUES, {
      id: "published-recording",
      duration: 60_000,
      audioBlob: new Blob(["old narration"], { type: "audio/ogg" }),
    }),
    "lesson-1",
  );
  return files.ne;
}

function run(
  cues: CaptionCue[],
  duration = 65_000,
): {
  title: string;
  artifacts: StudioRunArtifacts;
} {
  const audioBlob = new Blob(["new narration"], { type: "audio/ogg" });
  return {
    title: "Go error values",
    artifacts: {
      neBlob: new Blob([]),
      audioBlob,
      audioFileName: "lesson-go-error-values.ogg",
      recording: withCues(cues, { id: "run-recording", duration, audioBlob }),
    },
  };
}

const calls: string[] = [];

beforeEach(async () => {
  calls.length = 0;
  for (const mock of [mockedGet, mockedPut, mockedPatch, mockedDelete]) mock.mockReset();
  mockedGet.mockResolvedValue({ data: { lessons: [lesson()] } });
  mockedPut.mockImplementation((url: string) => {
    calls.push(`PUT ${url}`);
    return Promise.resolve({ data: { path: url } });
  });
  mockedPatch.mockImplementation((url: string, body?: unknown) => {
    calls.push(`PATCH ${url} ${JSON.stringify(body)}`);
    return Promise.resolve({ data: {} });
  });
  mockedDelete.mockImplementation((url: string) => {
    calls.push(`DELETE ${url}`);
    return Promise.resolve({ data: "" });
  });
  // jsdom's Blob is not one fetch's Response can read, so hand it bytes.
  const ne = new Uint8Array(await (await publishedNe()).arrayBuffer());
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith("/media/lessons/lesson-1/lesson-1.ne")
          ? new Response(ne.slice())
          : new Response("missing", { status: 404 }),
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("findPublishedLesson", () => {
  it("finds the one lesson with the title", async () => {
    mockedGet.mockResolvedValue({
      data: { lessons: [lesson(), lesson({ id: "lesson-2", slug: "other", title: "Other" })] },
    });

    await expect(findPublishedLesson({ title: "Go error values" })).resolves.toEqual({
      found: {
        lessonId: "lesson-1",
        urlSlug: "go-error-values",
        title: "Go error values",
        status: "published",
        duration: "1:00",
      },
    });
    expect(mockedGet).toHaveBeenCalledWith("/lessons/mine");
  });

  it("refuses when no lesson has the title", async () => {
    const match = await findPublishedLesson({ title: "Rust generics" });
    expect(match).toEqual({ refused: expect.stringContaining('titled "Rust generics"') });
  });

  it("refuses several matches and names each, drafts included", async () => {
    mockedGet.mockResolvedValue({
      data: {
        lessons: [lesson(), lesson({ id: "lesson-2", slug: "go-error-values-2", status: "draft" })],
      },
    });

    const match = await findPublishedLesson({ title: "Go error values" });
    expect("refused" in match && match.refused).toContain("go-error-values, published");
    expect("refused" in match && match.refused).toContain("go-error-values-2, draft");
  });

  it("takes the lesson its URL slug names, whatever the title", async () => {
    mockedGet.mockResolvedValue({
      data: {
        lessons: [lesson(), lesson({ id: "lesson-2", slug: "go-error-values-2", status: "draft" })],
      },
    });

    const match = await findPublishedLesson({
      title: "Something else",
      lesson: "go-error-values-2",
    });
    expect("found" in match && match.found).toMatchObject({
      lessonId: "lesson-2",
      status: "draft",
    });

    const missing = await findPublishedLesson({ title: "Go error values", lesson: "nope" });
    expect(missing).toEqual({ refused: expect.stringContaining('URL slug "nope"') });
  });

  it("says plainly when nobody is signed in", async () => {
    mockedGet.mockRejectedValue(unauthorized());
    const match = await findPublishedLesson({ title: "Go error values" });
    expect(match).toEqual({ refused: expect.stringContaining("not signed in") });
  });
});

describe("compareCaptions", () => {
  it("finds nothing to change in identical captions", () => {
    expect(compareCaptions(withCues(PUBLISHED_CUES), withCues(PUBLISHED_CUES))).toEqual({
      changedCues: 0,
      totalCues: 2,
      examples: [],
    });
  });

  it("quotes one changed cue as before → after", () => {
    const next = [PUBLISHED_CUES[0], cue("Return them to the caller.", 1_000)];
    expect(compareCaptions(withCues(PUBLISHED_CUES), withCues(next))).toEqual({
      changedCues: 1,
      totalCues: 2,
      examples: ['"Return them." → "Return them to the caller."'],
    });
  });

  it("counts cues only one side has, and cues that moved, words first", () => {
    const next = [
      cue("Errors are values.", 400),
      cue("Return them.", 1_000),
      cue("Wrap them.", 2_000),
    ];
    const change = compareCaptions(withCues(PUBLISHED_CUES), withCues(next));
    expect(change.totalCues).toBe(3);
    expect(change.changedCues).toBe(2);
    expect(change.examples).toEqual([
      '(no cue) → "Wrap them."',
      '"Errors are values.": 0:00.0–0:00.9 → 0:00.4–0:01.3',
    ]);
  });

  it("shows a cue whose end moved, in milliseconds when tenths read the same", () => {
    const published = [cue("What if it is odd?", 16_410, 17_520)];
    const endMoved = [cue("What if it is odd?", 16_410, 17_310)];
    expect(compareCaptions(withCues(published), withCues(endMoved)).examples).toEqual([
      '"What if it is odd?": 0:16.4–0:17.5 → 0:16.4–0:17.3',
    ]);
    const slightly = [cue("What if it is odd?", 16_412, 17_523)];
    expect(compareCaptions(withCues(published), withCues(slightly)).examples).toEqual([
      '"What if it is odd?": 0:16.410–0:17.520 → 0:16.412–0:17.523',
    ]);
  });

  it("matches repeated sentences by position", () => {
    const repeated = [cue("Run it.", 0), cue("Run it.", 1_000)];
    expect(compareCaptions(withCues(repeated), withCues(repeated)).changedCues).toBe(0);
  });
});

describe("replacePublishedLesson", () => {
  it("only compares when replace is false", async () => {
    const result = await replacePublishedLesson({
      lessonId: "lesson-1",
      run: run([PUBLISHED_CUES[0], cue("Return them now.", 1_000)]),
      replace: false,
    });

    expect(result).toEqual({
      compared: {
        lessonId: "lesson-1",
        urlSlug: "go-error-values",
        changedCues: 1,
        totalCues: 2,
        examples: ['"Return them." → "Return them now."'],
        publishedDurationMs: 60_000,
        newDurationMs: 65_000,
      },
    });
    expect(calls).toEqual([]);
  });

  it("puts the content-named narration, then the .ne, then the duration, then deletes the old narration", async () => {
    const result = await replacePublishedLesson({
      lessonId: "lesson-1",
      run: run(PUBLISHED_CUES),
      replace: true,
    });

    if (!("replaced" in result))
      throw new Error(`expected a replacement: ${JSON.stringify(result)}`);
    const { audioFile } = result.replaced;
    expect(audioFile).toMatch(/^lesson-1-[0-9a-f]{8}\.ogg$/);
    expect(calls).toEqual([
      `PUT /uploads/lesson-1/media/${audioFile}`,
      "PUT /uploads/lesson-1/media/lesson-1.ne",
      'PATCH /lessons/lesson-1 {"duration":"1:05"}',
      "DELETE /uploads/lesson-1/media/lesson-1.ogg",
    ]);
    expect(result.replaced.removedAudioFile).toBe("lesson-1.ogg");
    expect(result.replaced.newDurationMs).toBe(65_000);
  });

  it("keeps the published recording's id and nothing else from it", async () => {
    await replacePublishedLesson({ lessonId: "lesson-1", run: run(PUBLISHED_CUES), replace: true });

    const neBody = mockedPut.mock.calls[1][1] as Blob;
    const uploaded = await decompressBinaryToRecording(new Uint8Array(await neBody.arrayBuffer()));
    expect(uploaded.id).toBe("published-recording");
    expect(uploaded.duration).toBe(65_000);
    expect(uploaded.audioFile).toMatch(/^lesson-1-[0-9a-f]{8}\.ogg$/);
  });

  it("still reports the replacement when deleting the old narration fails", async () => {
    mockedDelete.mockRejectedValue(new Error("Request failed with status code 500"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await replacePublishedLesson({
      lessonId: "lesson-1",
      run: run(PUBLISHED_CUES),
      replace: true,
    });

    expect("replaced" in result && result.replaced.removedAudioFile).toBeNull();
    warn.mockRestore();
  });

  it("refuses a failed .ne PUT and says the narration was already put", async () => {
    mockedPut
      .mockImplementationOnce((url: string) => Promise.resolve({ data: { path: url } }))
      .mockImplementationOnce(() => Promise.reject(new Error("Network Error")));

    const result = await replacePublishedLesson({
      lessonId: "lesson-1",
      run: run(PUBLISHED_CUES),
      replace: true,
    });

    if (!("refused" in result)) throw new Error("expected a refusal");
    expect(result.refused).toContain("Putting the lesson file lesson-1.ne failed: Network Error");
    expect(result.refused).toMatch(/Already done: put the new narration lesson-1-[0-9a-f]{8}\.ogg/);
    expect(mockedPatch).not.toHaveBeenCalled();
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("refuses a lesson that is not the author's", async () => {
    const result = await replacePublishedLesson({
      lessonId: "someone-else",
      run: run(PUBLISHED_CUES),
      replace: true,
    });
    expect(result).toEqual({ refused: "None of your lessons has the id someone-else." });
    expect(calls).toEqual([]);
  });

  it("refuses when the published recording cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("gone", { status: 404 }))),
    );
    const result = await replacePublishedLesson({
      lessonId: "lesson-1",
      run: run(PUBLISHED_CUES),
      replace: true,
    });
    expect(result).toEqual({ refused: expect.stringContaining("HTTP 404") });
    expect(calls).toEqual([]);
  });
});
