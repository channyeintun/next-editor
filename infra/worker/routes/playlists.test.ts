import { beforeEach, describe, expect, it, vi } from "vitest";
import { playlistsRoute } from "./playlists";
import { getCurrentUser } from "../auth/session";
import { insertPlaylist, updatePlaylist } from "../../db/playlistQueries";
import type { PlaylistRow } from "../../db/types";

vi.mock("../auth/session", () => ({
  getCurrentUser: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../../db/playlistQueries", () => ({
  insertPlaylist: vi.fn<() => Promise<PlaylistRow>>(),
  updatePlaylist: vi.fn<() => Promise<PlaylistRow | null>>(async () => null),
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
