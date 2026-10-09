import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { lessonsRoute } from "./lessons";
import { getCurrentUser } from "../auth/session";
import {
  deleteLesson,
  getOwnedLessonById,
  insertDraftLesson,
  listPublishedLessons,
  updateLesson,
} from "../../db/queries";
import type { LessonRow } from "../../db/types";

vi.mock("../auth/session", () => ({
  getCurrentUser: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../../db/queries", () => ({
  insertDraftLesson: vi.fn<() => Promise<LessonRow>>(),
  listPublishedLessons: vi.fn<() => Promise<{ rows: LessonRow[]; nextPage: number | null }>>(),
  updateLesson: vi.fn<() => Promise<LessonRow | null>>(),
  getOwnedLessonById: vi.fn<() => Promise<LessonRow | null>>(async () => null),
  deleteLesson: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("../../db/slug", () => ({
  generateUniqueSlug: vi.fn<() => Promise<string>>(async () => "a-lesson"),
  isSlugUniqueViolation: () => false,
  MAX_SLUG_INSERT_ATTEMPTS: 3,
  slugifyTitle: (title: string, fallback: string) => title || fallback,
}));

const LESSON_ID = "4f0c2a5e-8c1b-4d0e-9a57-0b1f9d3e2c71";
const VICTIM_ID = "9b2d7c1e-3a4f-4e5b-8c6d-7e8f9a0b1c2d";

const env = { DB: {} as D1Database } as never;

function lessonRow(id: string): LessonRow {
  return {
    id,
    slug: "a-lesson",
    owner_id: "user-1",
    title: "A lesson",
    description: null,
    thumbnail: null,
    ne: `media/lessons/${id}/${id}.ne`,
    duration: null,
    tags: null,
    author: "Ada",
    author_url: "/learn/@ada",
    status: "draft",
    published_at: null,
    created_at: 1,
    updated_at: 1,
  };
}

function createLesson(body: Record<string, unknown>) {
  return lessonsRoute.request(
    "https://nexteditor.dev/",
    { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } },
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue({
    id: "user-1",
    name: "Ada",
    username: "ada",
  } as never);
  vi.mocked(insertDraftLesson).mockImplementation(async (_db, { id }) => lessonRow(id));
});

describe("lessonsRoute lesson ids", () => {
  it("creates a lesson whose media sits under its own id", async () => {
    const response = await createLesson({
      id: LESSON_ID,
      title: "A lesson",
      ne: `lessons/${LESSON_ID}/${LESSON_ID}.ne`,
    });

    expect(response.status).toBe(201);
    expect(insertDraftLesson).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: LESSON_ID, ne: `media/lessons/${LESSON_ID}/${LESSON_ID}.ne` }),
    );
  });

  it.each([`x/../${VICTIM_ID}`, `x%2f..%2f${VICTIM_ID}`, `..`, ""])(
    "refuses the id %j, which a browser could resolve to another lesson's media",
    async (id) => {
      const response = await createLesson({
        id,
        title: "Borrowed",
        ne: `lessons/${id}/${VICTIM_ID}.ne`,
        thumbnail: `lessons/${id}/thumb.png`,
      });

      expect(response.status).toBe(400);
      expect(insertDraftLesson).not.toHaveBeenCalled();
    },
  );

  it("answers 409 when the lesson id is already taken", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(insertDraftLesson).mockRejectedValueOnce(
      new Error("D1_ERROR: UNIQUE constraint failed: lessons.id: SQLITE_CONSTRAINT"),
    );

    const response = await createLesson({
      id: LESSON_ID,
      title: "A lesson",
      ne: `lessons/${LESSON_ID}/${LESSON_ID}.ne`,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "a lesson with this id already exists",
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // The client reads a 409 as "already uploaded", so a transient D1 failure
  // after a large upload must not answer with one.
  it("answers 500, not 409, when the insert fails for any other reason", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(insertDraftLesson).mockRejectedValueOnce(
      new Error("D1_ERROR: Network connection lost."),
    );

    const response = await createLesson({
      id: LESSON_ID,
      title: "A lesson",
      ne: `lessons/${LESSON_ID}/${LESSON_ID}.ne`,
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "failed to create lesson" });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("does not route an id outside the charset to the owner-only handlers", async () => {
    const response = await lessonsRoute.request(
      `https://nexteditor.dev/x..${VICTIM_ID}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title: "Renamed" }),
        headers: { "content-type": "application/json" },
      },
      env,
    );

    expect(response.status).toBe(404);
    expect(updateLesson).not.toHaveBeenCalled();
  });
});

describe("lessonsRoute gallery pages", () => {
  function listPage(page: number) {
    return lessonsRoute.request(`https://nexteditor.dev/?page=${page}`, undefined, env);
  }

  it("answers each request with the page D1 holds now", async () => {
    vi.mocked(listPublishedLessons).mockResolvedValue({
      rows: [{ ...lessonRow(LESSON_ID), status: "published" }],
      nextPage: 1,
    });

    const response = await listPage(0);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      lessons: [
        expect.objectContaining({
          slug: "a-lesson",
          ne: `media/lessons/${LESSON_ID}/${LESSON_ID}.ne`,
        }),
      ],
      nextPage: 1,
    });
    expect(listPublishedLessons).toHaveBeenCalledWith(expect.anything(), 0, 12);
  });

  it("answers a page past the end with an empty page", async () => {
    vi.mocked(listPublishedLessons).mockResolvedValue({ rows: [], nextPage: null });

    const response = await listPage(500);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ lessons: [], nextPage: null });
  });
});

describe("lessonsRoute delete", () => {
  function createBucket() {
    return {
      list: vi.fn<() => Promise<{ objects: { key: string }[] }>>(async () => ({
        objects: [{ key: `lessons/${LESSON_ID}/${LESSON_ID}.ne` }],
      })),
      delete: vi.fn<() => Promise<void>>(async () => undefined),
    };
  }

  function deleteRequest(bucket: ReturnType<typeof createBucket>) {
    return lessonsRoute.request(`https://nexteditor.dev/${LESSON_ID}`, { method: "DELETE" }, {
      DB: {} as D1Database,
      BUCKET: bucket as unknown as R2Bucket,
    } as never);
  }

  // deleteLesson matches only the caller's own row, so a false answer is the
  // 404, and another owner's media prefix must never be emptied.
  it("answers 404 and deletes no media for a lesson the caller does not own", async () => {
    vi.mocked(deleteLesson).mockResolvedValue(false);
    const bucket = createBucket();

    const response = await deleteRequest(bucket);

    expect(response.status).toBe(404);
    expect(deleteLesson).toHaveBeenCalledWith(expect.anything(), LESSON_ID, "user-1");
    expect(bucket.list).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("deletes the row and then the lesson's media", async () => {
    vi.mocked(deleteLesson).mockResolvedValue(true);
    const bucket = createBucket();

    const response = await deleteRequest(bucket);

    expect(response.status).toBe(200);
    expect(deleteLesson).toHaveBeenCalledWith(expect.anything(), LESSON_ID, "user-1");
    expect(bucket.list).toHaveBeenCalledWith({ prefix: `lessons/${LESSON_ID}/` });
    expect(bucket.delete).toHaveBeenCalledWith([`lessons/${LESSON_ID}/${LESSON_ID}.ne`]);
    expect(getOwnedLessonById).not.toHaveBeenCalled();
  });

  // Media removed first and a row that then failed to delete left a lesson,
  // possibly published, whose recording 404s for every viewer.
  it("keeps the media when the row could not be deleted", async () => {
    vi.mocked(deleteLesson).mockRejectedValue(new Error("D1_ERROR: network connection lost"));
    const bucket = createBucket();

    const response = await deleteRequest(bucket);

    expect(response.status).toBe(500);
    expect(bucket.delete).not.toHaveBeenCalled();
  });
});

describe("lessonsRoute text limits", () => {
  // Lesson text is served in every gallery page, search result and author
  // profile, and the edge render copies the title seven times and the
  // description five times into each page, so none of it may be unbounded.
  it.each([
    ["title", { title: "t".repeat(201) }],
    ["description", { description: "d".repeat(10_001) }],
    ["tag count", { tags: Array.from({ length: 31 }, (_, index) => `tag-${index}`) }],
    ["tag length", { tags: ["t".repeat(51)] }],
    ["duration", { duration: "9".repeat(33) }],
  ])("refuses a lesson whose %s is over its limit", async (_field, overLimit) => {
    const response = await createLesson({
      id: LESSON_ID,
      title: "A lesson",
      ne: `lessons/${LESSON_ID}/${LESSON_ID}.ne`,
      ...overLimit,
    });

    expect(response.status).toBe(400);
    expect(insertDraftLesson).not.toHaveBeenCalled();
  });

  it("accepts text at the limits", async () => {
    const response = await createLesson({
      id: LESSON_ID,
      title: "t".repeat(200),
      description: "d".repeat(10_000),
      tags: Array.from({ length: 30 }, () => "t".repeat(50)),
      duration: "9".repeat(32),
      ne: `lessons/${LESSON_ID}/${LESSON_ID}.ne`,
    });

    expect(response.status).toBe(201);
  });

  it("refuses an edit that would put the description over its limit", async () => {
    const response = await lessonsRoute.request(
      `https://nexteditor.dev/${LESSON_ID}`,
      {
        method: "PATCH",
        body: JSON.stringify({ description: "d".repeat(10_001) }),
        headers: { "content-type": "application/json" },
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(updateLesson).not.toHaveBeenCalled();
  });

  // The body is read under a byte ceiling before it is parsed, so a client
  // cannot make the Worker buffer and JSON.parse an arbitrarily large body.
  it("refuses a create body over the request ceiling", async () => {
    const response = await createLesson({
      id: LESSON_ID,
      title: "A lesson",
      ne: `lessons/${LESSON_ID}/${LESSON_ID}.ne`,
      padding: "x".repeat(128 * 1024),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body is too large" });
    expect(insertDraftLesson).not.toHaveBeenCalled();
  });

  it("refuses an edit whose declared length is over the request ceiling", async () => {
    const response = await lessonsRoute.request(
      `https://nexteditor.dev/${LESSON_ID}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title: "A lesson" }),
        headers: { "content-type": "application/json", "content-length": String(128 * 1024 + 1) },
      },
      env,
    );

    expect(response.status).toBe(413);
    expect(updateLesson).not.toHaveBeenCalled();
  });
});

describe("lessonsRoute route order", () => {
  // "/mine" and "/:slug" both match /mine; Hono picks the one registered first.
  it("routes /mine to the owner's library, not the slug lookup", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const response = await lessonsRoute.request("https://nexteditor.dev/mine", undefined, env);

    expect(response.status).toBe(401);
  });
});
