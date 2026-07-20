import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadsRoute } from "./uploads";
import { getCurrentUser } from "../auth/session";
import { getLessonById } from "../../db/queries";
import { MAX_CAPTION_BYTES } from "../../client/upload/captionConstraints";

vi.mock("../auth/session", () => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string } | null>>(async () => ({ id: "user-1" })),
}));

vi.mock("../../db/queries", () => ({
  getLessonById: vi.fn<() => Promise<null>>(async () => null),
}));

function createEnv() {
  const put = vi.fn<() => Promise<undefined>>(async () => undefined);
  const env = { DB: {} as D1Database, BUCKET: { put } as unknown as R2Bucket };
  return { env, put };
}

function putRequest(path: string, byteLength = 6): [string, RequestInit] {
  return [
    `https://nexteditor.dev${path}`,
    {
      method: "PUT",
      body: "WEBVTT",
      headers: {
        "content-length": String(byteLength),
        "content-type": "text/vtt",
      },
      // Node's fetch primitives require duplex for streaming request bodies.
      duplex: "half",
    } as RequestInit,
  ];
}

beforeEach(() => {
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
  vi.mocked(getLessonById).mockResolvedValue(null as never);
});

describe("uploadsRoute caption filenames", () => {
  it("accepts a language-suffixed sibling caption file", async () => {
    const { env, put } = createEnv();

    const response = await uploadsRoute.request(...putRequest("/l1/media/l1.pt-br.vtt"), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "lessons/l1/l1.pt-br.vtt" });
    expect(put).toHaveBeenCalledWith(
      "lessons/l1/l1.pt-br.vtt",
      expect.anything(),
      expect.objectContaining({ httpMetadata: { contentType: "text/vtt" } }),
    );
  });

  it("accepts a plain .vtt filename without a language segment", async () => {
    const { env } = createEnv();

    const response = await uploadsRoute.request(...putRequest("/l1/media/l1.vtt"), env);

    expect(response.status).toBe(200);
  });

  it("does not extend the dotted-basename shape to other extensions", async () => {
    const { env, put } = createEnv();

    const response = await uploadsRoute.request(...putRequest("/l1/media/l1.en.ogg"), env);

    expect(response.status).toBe(404);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects caption files over the caption size cap", async () => {
    const { env, put } = createEnv();

    const response = await uploadsRoute.request(
      ...putRequest("/l1/media/l1.en.vtt", MAX_CAPTION_BYTES + 1),
      env,
    );

    expect(response.status).toBe(413);
    expect(put).not.toHaveBeenCalled();
  });

  it("still requires a signed-in user", async () => {
    vi.mocked(getCurrentUser).mockResolvedValueOnce(null as never);
    const { env, put } = createEnv();

    const response = await uploadsRoute.request(...putRequest("/l1/media/l1.en.vtt"), env);

    expect(response.status).toBe(401);
    expect(put).not.toHaveBeenCalled();
  });
});
