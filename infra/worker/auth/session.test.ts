import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { authRoute } from "./session";
import { getSessionUser, updateUsername } from "../../db/queries";
import type { UserRow } from "../../db/types";

vi.mock("../../db/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/queries")>()),
  getSessionUser: vi.fn<() => Promise<UserRow | null>>(),
  updateUsername: vi.fn<() => Promise<unknown>>(),
}));

const env = { DB: {} as D1Database } as never;

function patchUsername(body: string) {
  return authRoute.request(
    "https://nexteditor.dev/username",
    {
      method: "PATCH",
      body,
      headers: { cookie: "ne_session=session-1", "content-type": "application/json" },
    },
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionUser).mockResolvedValue({ id: "user-1" } as UserRow);
});

describe("authRoute username", () => {
  it.each(["{username", "null", '"ada"', '{"username":"A!"}'])(
    "answers the body %j with 400",
    async (body) => {
      const response = await patchUsername(body);

      expect(response.status).toBe(400);
      expect(updateUsername).not.toHaveBeenCalled();
    },
  );

  it("refuses a body over the request ceiling", async () => {
    const response = await patchUsername(JSON.stringify({ username: "x".repeat(1024) }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body is too large" });
    expect(updateUsername).not.toHaveBeenCalled();
  });
});
