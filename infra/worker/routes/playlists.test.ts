import { beforeEach, describe, expect, it, vi } from "vitest";
import { playlistsRoute } from "./playlists";
import { getCurrentUser } from "../auth/session";
import {
  addLessonToPlaylist,
  deletePlaylist,
  insertPlaylist,
  updatePlaylist,
} from "../../db/playlistQueries";
import { playlistSlugKey } from "../cache";
import type { PlaylistRow } from "../../db/types";

vi.mock("../auth/session", () => ({
  getCurrentUser: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../../db/playlistQueries", () => ({
  insertPlaylist: vi.fn<() => Promise<PlaylistRow>>(),
  updatePlaylist: vi.fn<() => Promise<PlaylistRow | null>>(async () => null),
  deletePlaylist: vi.fn<() => Promise<string | null>>(),
  addLessonToPlaylist: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../../db/slug", () => ({
  generateUniqueSlug: vi.fn<() => Promise<string>>(async () => "a-playlist"),
  isSlugUniqueViolation: () => false,
  MAX_SLUG_INSERT_ATTEMPTS: 3,
}));

const env = { DB: {} as D1Database } as never;

function send(method: "POST" | "PATCH", path: string, body: Record<string, unknown>) {
  return playlistsRoute.request(
    `https://nexteditor.dev${path}`,
    { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } },
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
  vi.mocked(insertPlaylist).mockImplementation(async (_db, params) => ({
    id: params.id,
    slug: params.slug,
    owner_id: params.ownerId,
    title: params.title,
    description: params.description,
    created_at: 1,
    updated_at: 1,
  }));
});

describe("playlistsRoute text limits", () => {
  it.each([
    ["title", { title: "t".repeat(201) }],
    ["description", { title: "Mine", description: "d".repeat(10_001) }],
  ])("refuses a playlist whose %s is over its limit", async (_field, body) => {
    const response = await send("POST", "/", body);

    expect(response.status).toBe(400);
    expect(insertPlaylist).not.toHaveBeenCalled();
  });

  it("creates a playlist at the limits", async () => {
    const response = await send("POST", "/", {
      title: "t".repeat(200),
      description: "d".repeat(10_000),
    });

    expect(response.status).toBe(201);
  });

  it("refuses an edit that would put the title over its limit", async () => {
    const response = await send("PATCH", "/playlist-1", { title: "t".repeat(201) });

    expect(response.status).toBe(400);
    expect(updatePlaylist).not.toHaveBeenCalled();
  });
});

describe("playlistsRoute cache invalidation", () => {
  function withCache() {
    const cache = { delete: vi.fn<(key: string) => Promise<void>>(async () => undefined) };
    return { cache, env: { DB: {} as D1Database, CACHE: cache as unknown as KVNamespace } };
  }

  // The mutation answers with the slug it changed, so the route invalidates
  // that playlist's key without reading the row again.
  it("invalidates the deleted playlist's key", async () => {
    vi.mocked(deletePlaylist).mockResolvedValue("my-list");
    const { cache, env: cachedEnv } = withCache();

    const response = await playlistsRoute.request(
      "https://nexteditor.dev/playlist-1",
      { method: "DELETE" },
      cachedEnv as never,
    );

    expect(response.status).toBe(200);
    expect(cache.delete).toHaveBeenCalledWith(playlistSlugKey("my-list"));
  });

  it("answers 404 and invalidates nothing for a playlist the caller does not own", async () => {
    vi.mocked(deletePlaylist).mockResolvedValue(null);
    const { cache, env: cachedEnv } = withCache();

    const response = await playlistsRoute.request(
      "https://nexteditor.dev/playlist-1",
      { method: "DELETE" },
      cachedEnv as never,
    );

    expect(response.status).toBe(404);
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it("invalidates the playlist a lesson was added to", async () => {
    vi.mocked(addLessonToPlaylist).mockResolvedValue({ status: "ok", slug: "my-list" });
    const { cache, env: cachedEnv } = withCache();

    const response = await playlistsRoute.request(
      "https://nexteditor.dev/playlist-1/lessons",
      {
        method: "POST",
        body: JSON.stringify({ lessonId: "lesson-1" }),
        headers: { "content-type": "application/json" },
      },
      cachedEnv as never,
    );

    expect(response.status).toBe(201);
    expect(cache.delete).toHaveBeenCalledWith(playlistSlugKey("my-list"));
  });
});
