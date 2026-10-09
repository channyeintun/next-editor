import { describe, expect, it, vi } from "vite-plus/test";
import { slideImagesRoute } from "./slideImages";

vi.mock("../auth/session", () => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: "user-1" })),
}));

function ingest(body: string) {
  return slideImagesRoute.request(
    "https://nexteditor.dev/",
    { method: "POST", body, headers: { "content-type": "application/json" } },
    { BUCKET: {} as R2Bucket } as never,
  );
}

describe("slideImagesRoute request validation", () => {
  // Every JSON value is a valid body, including `null`, which has no
  // properties to read.
  it.each(["null", "[]", "1", '"urls"', "{}", '{"urls":[]}', '{"urls":[1]}'])(
    "answers the body %s with 400",
    async (body) => {
      const response = await ingest(body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "'urls' must be a non-empty array of strings",
      });
    },
  );

  it("answers a body that is not JSON with 400", async () => {
    const response = await ingest("{urls");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid JSON body" });
  });

  it("refuses a body over the request ceiling before parsing it", async () => {
    const response = await ingest(JSON.stringify({ urls: ["x".repeat(64 * 1024)] }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body is too large" });
  });
});
