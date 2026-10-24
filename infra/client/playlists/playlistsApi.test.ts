import { describe, expect, it, vi } from "vite-plus/test";

const post = vi.hoisted(() =>
  vi.fn<(url: string, body: { lessonIds: string[] }) => Promise<{ data: unknown }>>(),
);
vi.mock("../apiClient", () => ({ apiClient: { post } }));

const { addLessonsToPlaylist } = await import("./playlistsApi");

describe("addLessonsToPlaylist", () => {
  it("splits a selection over the per-request limit into ordered requests", async () => {
    post.mockImplementation(async (_url, body) => ({
      data: { added: body.lessonIds, alreadyAdded: [], notEligible: [] },
    }));
    const lessonIds = Array.from({ length: 450 }, (_, index) => `l-${index}`);

    const outcome = await addLessonsToPlaylist("p1", lessonIds);

    expect(post.mock.calls.map(([, body]) => body.lessonIds.length)).toEqual([200, 200, 50]);
    expect(post.mock.calls[1][1].lessonIds[0]).toBe("l-200");
    expect(outcome.added).toEqual(lessonIds);
  });
});
