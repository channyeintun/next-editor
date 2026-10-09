import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { playlistsRoute } from "./playlists";
import { getCurrentUser } from "../auth/session";
import {
  addLessonToPlaylist,
  deletePlaylist,
  getPlaylistBySlug,
  insertPlaylist,
  updatePlaylist,
  type PlaylistWithLessons,
} from "../../db/playlistQueries";
import type { LessonRow, PlaylistRow } from "../../db/types";

vi.mock("../auth/session", () => ({
  getCurrentUser: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../../db/playlistQueries", () => ({
  insertPlaylist: vi.fn<() => Promise<PlaylistRow>>(),
  updatePlaylist: vi.fn<() => Promise<PlaylistRow | null>>(async () => null),
  deletePlaylist: vi.fn<() => Promise<string | null>>(),
  addLessonToPlaylist: vi.fn<() => Promise<unknown>>(),
  getPlaylistBySlug: vi.fn<() => Promise<PlaylistWithLessons | null>>(),
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

  // The body is read under a byte ceiling before it is parsed, so a client
  // cannot make the Worker buffer and JSON.parse an arbitrarily large body.
  it("refuses a body over the request ceiling", async () => {
    const response = await send("POST", "/", { title: "Mine", padding: "x".repeat(128 * 1024) });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body is too large" });
    expect(insertPlaylist).not.toHaveBeenCalled();
  });
});

describe("playlistsRoute mutations", () => {
  // The mutation answers with the playlist's slug, or null when the caller
  // does not own it.
  it("deletes the caller's playlist", async () => {
    vi.mocked(deletePlaylist).mockResolvedValue("my-list");

    const response = await playlistsRoute.request(
      "https://nexteditor.dev/playlist-1",
      { method: "DELETE" },
      env,
    );

    expect(response.status).toBe(200);
  });

  it("answers 404 for a playlist the caller does not own", async () => {
    vi.mocked(deletePlaylist).mockResolvedValue(null);

    const response = await playlistsRoute.request(
      "https://nexteditor.dev/playlist-1",
      { method: "DELETE" },
      env,
    );

    expect(response.status).toBe(404);
  });

  it("adds a lesson to the caller's playlist", async () => {
    vi.mocked(addLessonToPlaylist).mockResolvedValue({ status: "ok", slug: "my-list" });

    const response = await send("POST", "/playlist-1/lessons", { lessonId: "lesson-1" });

    expect(response.status).toBe(201);
  });
});

describe("playlistsRoute public read", () => {
  const playlist: PlaylistRow = {
    id: "playlist-1",
    slug: "my-list",
    owner_id: "user-1",
    title: "My list",
    description: null,
    created_at: 1,
    updated_at: 1,
  };
  const member = {
    slug: "a-lesson",
    title: "A lesson",
    description: null,
    thumbnail: null,
    ne: "media/lessons/l1/l1.ne",
    duration: null,
    tags: null,
    author: null,
    author_url: null,
    published_at: null,
  } as LessonRow;

  // Straight from D1 on every request, so an edit shows up on the next read.
  it("answers with the playlist and its published members as D1 holds them", async () => {
    vi.mocked(getPlaylistBySlug).mockResolvedValue({ playlist, lessons: [member] });

    const response = await playlistsRoute.request("https://nexteditor.dev/my-list", undefined, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slug: "my-list",
      title: "My list",
      description: "",
      lessons: [expect.objectContaining({ slug: "a-lesson", ne: "media/lessons/l1/l1.ne" })],
    });
    expect(getPlaylistBySlug).toHaveBeenCalledWith(expect.anything(), "my-list");
  });

  it("answers 404 for an unknown slug", async () => {
    vi.mocked(getPlaylistBySlug).mockResolvedValue(null);

    const response = await playlistsRoute.request("https://nexteditor.dev/nope", undefined, env);

    expect(response.status).toBe(404);
  });
});
