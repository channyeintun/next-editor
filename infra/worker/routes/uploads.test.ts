import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { uploadsRoute } from "./uploads";
import { getCurrentUser } from "../auth/session";
import { getLessonById } from "../../db/queries";
import { MAX_MEDIA_BYTES_PER_OWNER } from "../../db/ownerLimits";
import { insertSignedInUser, openSqliteD1, type SqliteD1 } from "../../db/testing";
import { MAX_CAPTION_BYTES, MAX_THUMBNAIL_BYTES } from "../../lessons/uploadLimits";
import { LESSON_MEDIA_EXTENSIONS } from "../lessonMediaFiles";
import { countingRateLimiter, refusingRateLimiter } from "../testing/rateLimit";

vi.mock("../auth/session", () => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string } | null>>(async () => ({ id: "user-1" })),
}));

vi.mock("../../db/queries", () => ({
  getLessonById: vi.fn<() => Promise<null>>(async () => null),
}));

let database: SqliteD1;

function createEnv() {
  const put = vi.fn<() => Promise<undefined>>(async () => undefined);
  const del = vi.fn<() => Promise<undefined>>(async () => undefined);
  const env = {
    DB: database.db,
    BUCKET: { put, delete: del } as unknown as R2Bucket,
    MEDIA_UPLOAD_RATE_LIMITER: countingRateLimiter(Infinity) as RateLimit | undefined,
  };
  return { env, put, del };
}

function mediaObjects() {
  return database.sqlite.prepare("SELECT key, owner_id, bytes FROM media_objects").all();
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
  database = openSqliteD1();
  insertSignedInUser(database.sqlite, "user-1", "session-1");
  insertSignedInUser(database.sqlite, "user-2", "session-2");
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
    // Nor does it count against the user's storage.
    expect(mediaObjects()).toEqual([]);
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

describe("uploadsRoute storage bounds", () => {
  // Any signed-in user used to be able to store any number of objects under
  // any number of fresh ids, bounded only per request.
  it("records each upload against the user's storage, replacing a re-upload's size", async () => {
    const { env } = createEnv();

    expect((await uploadsRoute.request(...putRequest("/l1/media/l1.ne", 6), env)).status).toBe(200);
    expect((await uploadsRoute.request(...putRequest("/l1/media/l1.ne", 4), env)).status).toBe(200);
    expect((await uploadsRoute.request(...putRequest("/l2/media/l2.ne", 5), env)).status).toBe(200);

    expect(mediaObjects()).toEqual([
      { key: "lessons/l1/l1.ne", owner_id: "user-1", bytes: 4 },
      { key: "lessons/l2/l2.ne", owner_id: "user-1", bytes: 5 },
    ]);
  });

  it("refuses an upload past the user's storage quota, before writing it", async () => {
    const { env, put } = createEnv();
    database.sqlite
      .prepare(
        "INSERT INTO media_objects (key, owner_id, bytes, created_at, updated_at) VALUES ('lessons/old/old.ne', 'user-1', ?, 0, 0)",
      )
      .run(MAX_MEDIA_BYTES_PER_OWNER - 5);

    const response = await uploadsRoute.request(...putRequest("/fresh/media/fresh.ne", 6), env);

    expect(response.status).toBe(507);
    expect(await response.json()).toEqual({
      error: "Your storage is full — delete a lesson to make room",
    });
    expect(put).not.toHaveBeenCalled();
    // Another user's quota is their own.
    vi.mocked(getCurrentUser).mockResolvedValueOnce({ id: "user-2" } as never);
    expect((await uploadsRoute.request(...putRequest("/other/media/o.ne", 6), env)).status).toBe(
      200,
    );
  });

  it("never lets another user write a key someone else's upload recorded", async () => {
    const { env, put } = createEnv();
    await uploadsRoute.request(...putRequest("/l1/media/l1.ne"), env);
    put.mockClear();

    vi.mocked(getCurrentUser).mockResolvedValueOnce({ id: "user-2" } as never);
    const response = await uploadsRoute.request(...putRequest("/l1/media/l1.ne"), env);

    expect(response.status).toBe(403);
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses a fresh id longer than a UUID needs, and a filename past its limit", async () => {
    const { env, put } = createEnv();
    const longId = "a".repeat(65);

    const longIdResponse = await uploadsRoute.request(...putRequest(`/${longId}/media/a.ne`), env);
    const longName = await uploadsRoute.request(
      ...putRequest(`/l1/media/${"a".repeat(126)}.ne`),
      env,
    );

    expect(longIdResponse.status).toBe(400);
    expect(longName.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
    // An existing lesson keeps whatever id it was created with.
    vi.mocked(getLessonById).mockResolvedValueOnce({ owner_id: "user-1" } as never);
    expect((await uploadsRoute.request(...putRequest(`/${longId}/media/a.ne`), env)).status).toBe(
      200,
    );
  });

  it("charges each upload to the user's budget, and fails closed without one", async () => {
    const { env, put } = createEnv();
    const limiter = countingRateLimiter(1);

    const first = await uploadsRoute.request(...putRequest("/l1/media/l1.ne"), {
      ...env,
      MEDIA_UPLOAD_RATE_LIMITER: limiter,
    });
    const second = await uploadsRoute.request(...putRequest("/l1/media/l1.ne"), {
      ...env,
      MEDIA_UPLOAD_RATE_LIMITER: limiter,
    });
    const refused = await uploadsRoute.request(...putRequest("/l1/media/l1.ne"), {
      ...env,
      MEDIA_UPLOAD_RATE_LIMITER: refusingRateLimiter(),
    });
    const missing = await uploadsRoute.request(...putRequest("/l1/media/l1.ne"), {
      ...env,
      MEDIA_UPLOAD_RATE_LIMITER: undefined,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(refused.status).toBe(429);
    expect(missing.status).toBe(503);
    expect(limiter.keys).toEqual(["user:user-1", "user:user-1"]);
    expect(put).toHaveBeenCalledTimes(1);
  });
});
