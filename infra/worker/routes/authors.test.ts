import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { authorsRoute } from "./authors";
import { getPublishedAuthorProfile, type PublishedAuthorProfile } from "../../db/authorQueries";
import type { LessonRow, PlaylistRowWithCount, UserRow } from "../../db/types";

vi.mock("../../db/authorQueries", () => ({
  getPublishedAuthorProfile: vi.fn<() => Promise<PublishedAuthorProfile | null>>(),
}));

const db = {} as D1Database;
const env = { DB: db } as never;

const user: UserRow = {
  id: "ada-id",
  google_sub: "google-ada",
  email: "ada@example.com",
  name: "Ada",
  avatar_url: "https://example.com/ada.png",
  username: "ada",
  created_at: 0,
};

const lesson: LessonRow = {
  id: "lesson-1",
  slug: "lesson-one",
  owner_id: "ada-id",
  title: "Lesson one",
  description: null,
  thumbnail: null,
  ne: "/media/lessons/lesson-1/lesson-1.ne",
  duration: "4:12",
  tags: '["rust"]',
  author: "Ada",
  author_url: "/learn/@ada",
  status: "published",
  published_at: Date.UTC(2026, 9, 1),
  created_at: 0,
  updated_at: 0,
};

const playlist: PlaylistRowWithCount = {
  id: "playlist-1",
  slug: "my-list",
  owner_id: "ada-id",
  title: "My list",
  description: null,
  created_at: 0,
  updated_at: 0,
  lesson_count: 1,
  first_lesson_thumbnail: null,
};

function get(username: string) {
  return authorsRoute.request(`https://nexteditor.dev/${username}`, {}, env);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/authors/:username", () => {
  it("answers the public profile from one profile read", async () => {
    vi.mocked(getPublishedAuthorProfile).mockResolvedValue({
      user,
      lessons: [lesson],
      playlists: [playlist],
    });

    const response = await get("ada");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: { username: "ada", name: "Ada", avatarUrl: "https://example.com/ada.png" },
      lessons: [
        {
          slug: "lesson-one",
          title: "Lesson one",
          description: "",
          thumbnail: "",
          ne: "/media/lessons/lesson-1/lesson-1.ne",
          duration: "4:12",
          tags: ["rust"],
          author: "Ada",
          authorUrl: "/learn/@ada",
          publishedAt: "2026-10-01",
        },
      ],
      playlists: [
        { slug: "my-list", title: "My list", description: "", lessonCount: 1, thumbnail: null },
      ],
    });
    expect(getPublishedAuthorProfile).toHaveBeenCalledExactlyOnceWith(db, "ada");
  });

  it("answers 404 for an unknown username", async () => {
    vi.mocked(getPublishedAuthorProfile).mockResolvedValue(null);

    const response = await get("nobody");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });
});
