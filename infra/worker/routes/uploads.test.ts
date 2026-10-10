import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { uploadsRoute } from "./uploads";
import { getCurrentUser } from "../auth/session";
import { getLessonById } from "../../db/queries";
import { MAX_CAPTION_BYTES, MAX_THUMBNAIL_BYTES } from "../../lessons/uploadLimits";
import { LESSON_MEDIA_EXTENSIONS } from "../lessonMediaFiles";

vi.mock("../auth/session", () => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string } | null>>(async () => ({ id: "user-1" })),
}));

vi.mock("../../db/queries", () => ({
  getLessonById: vi.fn<() => Promise<null>>(async () => null),
}));

function createEnv() {
  const put = vi.fn<() => Promise<undefined>>(async () => undefined);
  const del = vi.fn<() => Promise<undefined>>(async () => undefined);
  const env = { DB: {} as D1Database, BUCKET: { put, delete: del } as unknown as R2Bucket };
  return { env, put, del };
}

function putRequest(path: string, byteLength = 6, signal?: AbortSignal): [string, RequestInit] {
  return [
    `https://nexteditor.dev${path}`,
    {
      method: "PUT",
      body: "WEBVTT",
      headers: {
        "content-length": String(byteLength),
        "content-type": "text/vtt",
      },
      signal,
      // Node's fetch primitives require duplex for streaming request bodies.
      duplex: "half",
    } as RequestInit,
  ];
}

beforeEach(() => {
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
  vi.mocked(getLessonById).mockResolvedValue(null as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("uploadsRoute cancelled uploads", () => {
  function silenceLogs() {
    return {
      log: vi.spyOn(console, "log").mockImplementation(() => undefined),
      error: vi.spyOn(console, "error").mockImplementation(() => undefined),
    };
  }

  // What R2's put rejects with when the browser drops the connection while the
  // body is still streaming in (seen in wrangler dev).
  it("answers 499 with no body when the body breaks off", async () => {
    const logs = silenceLogs();
    const { env, put, del } = createEnv();
    put.mockRejectedValueOnce(new Error("Network connection lost."));

    const response = await uploadsRoute.request(...putRequest("/l1/media/l1.ne"), env);

    expect(response.status).toBe(499);
    expect(await response.text()).toBe("");
    expect(logs.log).toHaveBeenCalledTimes(1);
    expect(logs.log).toHaveBeenCalledWith("Upload cancelled by the client", {
      key: "lessons/l1/l1.ne",
      contentLength: 6,
      clientCancelled: true,
    });
    expect(logs.error).not.toHaveBeenCalled();
    // A failed put stores nothing, and the key may hold the file being replaced.
    expect(del).not.toHaveBeenCalled();
  });

  it("answers 499 once the request signal says the browser left", async () => {
    const logs = silenceLogs();
    const { env, put } = createEnv();
    const browser = new AbortController();
    put.mockImplementationOnce(async () => {
      browser.abort();
      throw new TypeError("This ReadableStream is errored.");
    });

    const response = await uploadsRoute.request(
      ...putRequest("/l1/media/l1.ne", 6, browser.signal),
      env,
    );

    expect(response.status).toBe(499);
    expect(logs.log).toHaveBeenCalledWith(
      "Upload cancelled by the client",
      expect.objectContaining({ clientCancelled: true }),
    );
    expect(logs.error).not.toHaveBeenCalled();
  });

  it("keeps any other storage failure a logged 500", async () => {
    const logs = silenceLogs();
    const { env, put, del } = createEnv();
    const failure = new Error("put: We encountered an internal error. Please try again. (10001)");
    put.mockRejectedValueOnce(failure);

    const response = await uploadsRoute.request(...putRequest("/l1/media/l1.ne"), env);

    expect(response.status).toBe(500);
    expect(logs.error).toHaveBeenCalledWith(failure);
    expect(logs.log).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});

describe("uploadsRoute caption filenames", () => {
  it("accepts a language-suffixed sibling caption file", async () => {
    const { env, put } = createEnv();

    const response = await uploadsRoute.request(...putRequest("/l1/media/l1.pt-br.vtt"), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "lessons/l1/l1.pt-br.vtt" });
    expect(put).toHaveBeenCalledWith(
      "lessons/l1/l1.pt-br.vtt",
      expect.anything(),
      expect.objectContaining({ httpMetadata: { contentType: "text/vtt" } }),
    );
  });

  // uploadLesson.ts numbers a second track in one language before the tag.
  it("accepts a numbered caption file for a second track in a language", async () => {
    const { env, put } = createEnv();

    const response = await uploadsRoute.request(...putRequest("/l1/media/l1-2.en.vtt"), env);

    expect(response.status).toBe(200);
    expect(put).toHaveBeenCalledWith(
      "lessons/l1/l1-2.en.vtt",
      expect.anything(),
      expect.anything(),
    );
  });

  it("accepts a plain .vtt filename without a language segment", async () => {
    const { env } = createEnv();

    const response = await uploadsRoute.request(...putRequest("/l1/media/l1.vtt"), env);

    expect(response.status).toBe(200);
  });

  it("does not extend the dotted-basename shape to other extensions", async () => {
    const { env, put } = createEnv();

    const response = await uploadsRoute.request(...putRequest("/l1/media/l1.en.ogg"), env);

    expect(response.status).toBe(404);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects caption files over the caption size cap", async () => {
    const { env, put } = createEnv();

    const response = await uploadsRoute.request(
      ...putRequest("/l1/media/l1.en.vtt", MAX_CAPTION_BYTES + 1),
      env,
    );

    expect(response.status).toBe(413);
    expect(put).not.toHaveBeenCalled();
  });

  it("still requires a signed-in user", async () => {
    vi.mocked(getCurrentUser).mockResolvedValueOnce(null as never);
    const { env, put } = createEnv();

    const response = await uploadsRoute.request(...putRequest("/l1/media/l1.en.vtt"), env);

    expect(response.status).toBe(401);
    expect(put).not.toHaveBeenCalled();
  });
});

describe("uploadsRoute media filenames", () => {
  // Derived from src/shared/recordingMediaFiles.ts; pins the set the route accepted
  // when it was a hand-kept list.
  it("allows the same media extensions as the hand-kept list it replaced", () => {
    expect(new Set(LESSON_MEDIA_EXTENSIONS)).toEqual(
      new Set([
        "ne",
        "ogg",
        "weba",
        "webm",
        "mp4",
        "mov",
        "m4a",
        "mp3",
        "wav",
        "png",
        "jpg",
        "jpeg",
        "webp",
      ]),
    );
    expect(LESSON_MEDIA_EXTENSIONS).toHaveLength(13);
  });

  // The route pattern is built from the same list lessons.ts checks a row's
  // `ne`/`thumbnail` against, so every extension a row may point at uploads.
  it.each(LESSON_MEDIA_EXTENSIONS)("accepts a .%s file", async (extension) => {
    const { env, put } = createEnv();

    const response = await uploadsRoute.request(...putRequest(`/l1/media/l1.${extension}`), env);

    expect(response.status).toBe(200);
    expect(put).toHaveBeenCalledWith(
      `lessons/l1/l1.${extension}`,
      expect.anything(),
      expect.anything(),
    );
  });

  // resizeThumbnail encodes WebP; it must be stored as an image and held to the
  // thumbnail cap, not the much larger recording-media one.
  it("stores a .webp thumbnail as image/webp under the thumbnail size cap", async () => {
    const { env, put } = createEnv();

    const stored = await uploadsRoute.request(...putRequest("/l1/media/l1-thumbnail.webp"), env);
    expect(stored.status).toBe(200);
    expect(put).toHaveBeenCalledWith(
      "lessons/l1/l1-thumbnail.webp",
      expect.anything(),
      expect.objectContaining({ httpMetadata: { contentType: "image/webp" } }),
    );

    const oversized = await uploadsRoute.request(
      ...putRequest("/l1/media/l1-thumbnail-1791222405295.webp", MAX_THUMBNAIL_BYTES + 1),
      env,
    );
    expect(oversized.status).toBe(413);
  });

  it.each(["l1.svg", "l1.html", "l1.ne.html"])("refuses %s", async (filename) => {
    const { env, put } = createEnv();

    const response = await uploadsRoute.request(...putRequest(`/l1/media/${filename}`), env);

    expect(response.status).toBe(404);
    expect(put).not.toHaveBeenCalled();
  });
});
