import { beforeEach, describe, expect, it, vi } from "vitest";
import { lessonsRoute } from "./lessons";
import { getCurrentUser } from "../auth/session";
import { insertDraftLesson, updateLesson } from "../../db/queries";
import type { LessonRow } from "../../db/types";

vi.mock("../auth/session", () => ({
  getCurrentUser: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../../db/queries", () => ({
  insertDraftLesson: vi.fn<() => Promise<LessonRow>>(),
  updateLesson: vi.fn<() => Promise<LessonRow | null>>(),
  getLessonById: vi.fn<() => Promise<null>>(async () => null),
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
