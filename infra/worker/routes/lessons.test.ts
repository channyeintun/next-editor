import { beforeEach, describe, expect, it, vi } from "vitest";
import { lessonsRoute } from "./lessons";
import { getCurrentUser } from "../auth/session";
import {
  deleteLesson,
  getLessonById,
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
  getLessonById: vi.fn<() => Promise<LessonRow | null>>(async () => null),
  deleteLesson: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("../../db/slug", () => ({
  generateUniqueSlug: vi.fn<() => Promise<string>>(async () => "a-lesson"),
  isSlugUniqueViolation: () => false,
  MAX_SLUG_INSERT_ATTEMPTS: 3,
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
  function createKv() {
    return {
      get: vi.fn<() => Promise<null>>(async () => null),
      put: vi.fn<() => Promise<void>>(async () => undefined),
    };
  }

  function listPage(page: number, cache: ReturnType<typeof createKv>) {
    return lessonsRoute.request(`https://nexteditor.dev/?page=${page}`, undefined, {
      DB: {} as D1Database,
      CACHE: cache as unknown as KVNamespace,
    } as never);
  }

  it("caches a page that has lessons on it", async () => {
    vi.mocked(listPublishedLessons).mockResolvedValue({
      rows: [{ ...lessonRow(LESSON_ID), status: "published" }],
      nextPage: null,
    });
    const cache = createKv();

    const response = await listPage(0, cache);

    expect(response.status).toBe(200);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  // Every distinct ?page= is its own KV key, so caching an empty page let an
  // unauthenticated loop over page numbers mint one billable KV write each.
  it("answers a page past the end without writing it to KV", async () => {
    vi.mocked(listPublishedLessons).mockResolvedValue({ rows: [], nextPage: null });
    const cache = createKv();

    const response = await listPage(500, cache);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ lessons: [], nextPage: null });
    expect(cache.put).not.toHaveBeenCalled();
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

  beforeEach(() => {
    vi.mocked(getLessonById).mockResolvedValue(lessonRow(LESSON_ID));
  });

  it("deletes the row and then the lesson's media", async () => {
    vi.mocked(deleteLesson).mockResolvedValue(true);
    const bucket = createBucket();

    const response = await deleteRequest(bucket);

    expect(response.status).toBe(200);
    expect(bucket.delete).toHaveBeenCalledWith([`lessons/${LESSON_ID}/${LESSON_ID}.ne`]);
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
});

describe("lessonsRoute route order", () => {
  // "/mine" and "/:slug" both match /mine; Hono picks the one registered first.
  it("routes /mine to the owner's library, not the slug lookup", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const response = await lessonsRoute.request("https://nexteditor.dev/mine", undefined, env);

    expect(response.status).toBe(401);
  });
});
