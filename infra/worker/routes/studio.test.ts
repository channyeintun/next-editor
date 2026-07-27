import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeWavPcm16 } from "../../../src/studio/tts/wav";
import type { UserRow } from "../../db/types";
import type { Env } from "../env";
import { studioRoute } from "./studio";

function base64Of(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

function referenceAudioBase64(seconds = 5): string {
  return base64Of(encodeWavPcm16(new Int16Array(24_000 * seconds), 24_000));
}

const REFERENCE_AUDIO_BASE64 = referenceAudioBase64();

const USER: UserRow = {
  id: "user-1",
  google_sub: "google-1",
  email: "user@example.com",
  name: "User",
  avatar_url: null,
  username: "user",
  created_at: 0,
};

function dbWithAccess(user: UserRow | null, enabled: boolean): D1Database {
  return {
    prepare: (query: string) => ({
      bind: () => ({
        first: async () => {
          if (query.includes("FROM sessions")) return user;
          if (query.includes("FROM user_feature_flags")) {
            return enabled ? { enabled: 1 } : null;
          }
          return null;
        },
      }),
    }),
  } as unknown as D1Database;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: dbWithAccess(USER, true),
    VOXCPM2_MODAL_ENDPOINT: "https://owner--next-editor-voxcpm2-synthesize.modal.run",
    MODAL_PROXY_TOKEN_ID: "wk-test",
    MODAL_PROXY_TOKEN_SECRET: "ws-test",
    ...overrides,
  } as Env;
}

function request(
  path: string,
  env: Env,
  init: RequestInit = {
    method: "GET",
  },
) {
  const headers = new Headers(init.headers);
  headers.set("Cookie", "ne_session=session-1");
  return studioRoute.request(`https://nexteditor.dev${path}`, { ...init, headers }, env);
}

function synthesisBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    text: "မင်္ဂလာပါ။",
    seed: 42,
    referenceAudioBase64: REFERENCE_AUDIO_BASE64,
    ...overrides,
  });
}

function postSynthesis(env: Env, body: BodyInit = synthesisBody()) {
  return request("/tts/voxcpm2", env, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("studioRoute capabilities", () => {
  it("requires a signed-in user", async () => {
    const response = await request("/capabilities", makeEnv({ DB: dbWithAccess(null, true) }));

    expect(response.status).toBe(401);
  });

  it("exposes Burmese VoxCPM2 only when the user flag and Modal config are present", async () => {
    const enabled = await request("/capabilities", makeEnv());
    expect(await enabled.json()).toEqual({ burmeseVoxCpm2: true });

    const disabled = await request("/capabilities", makeEnv({ DB: dbWithAccess(USER, false) }));
    expect(await disabled.json()).toEqual({ burmeseVoxCpm2: false });

    const unconfigured = await request(
      "/capabilities",
      makeEnv({ MODAL_PROXY_TOKEN_SECRET: undefined }),
    );
    expect(await unconfigured.json()).toEqual({ burmeseVoxCpm2: false });
  });
});

describe("studioRoute VoxCPM2 proxy", () => {
  it("rechecks the D1 flag before contacting Modal", async () => {
    const fetchSpy =
      vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await postSynthesis(makeEnv({ DB: dbWithAccess(USER, false) }));

    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed and overlong synthesis requests", async () => {
    const fetchSpy =
      vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchSpy);

    expect((await postSynthesis(makeEnv(), "not-json")).status).toBe(400);
    expect(
      (await postSynthesis(makeEnv(), JSON.stringify({ text: "မင်္ဂလာပါ။", seed: 42 }))).status,
    ).toBe(400);
    expect(
      (await postSynthesis(makeEnv(), synthesisBody({ text: "x".repeat(2_001) }))).status,
    ).toBe(400);
    expect((await postSynthesis(makeEnv(), synthesisBody({ provider: "other" }))).status).toBe(400);
    expect(
      (await postSynthesis(makeEnv(), synthesisBody({ referenceAudioBase64: "not-base64" })))
        .status,
    ).toBe(400);
    expect(
      (
        await postSynthesis(
          makeEnv(),
          synthesisBody({ referenceAudioBase64: referenceAudioBase64(4) }),
        )
      ).status,
    ).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends only validated text, seed, reference audio, and proxy credentials upstream", async () => {
    const wav = new Uint8Array([82, 73, 70, 70]);
    const fetchSpy = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () => {
      return new Response(wav.slice().buffer, {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const response = await postSynthesis(makeEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(wav);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://owner--next-editor-voxcpm2-synthesize.modal.run/");
    expect(init?.headers).toMatchObject({
      "Modal-Key": "wk-test",
      "Modal-Secret": "ws-test",
    });
    expect(init?.signal).toBeUndefined();
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "မင်္ဂလာပါ။",
      seed: 42,
      reference_audio_base64: REFERENCE_AUDIO_BASE64,
    });
  });

  it("rejects a non-Modal endpoint and an unexpected upstream response", async () => {
    const fetchSpy = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () => {
      return new Response(JSON.stringify({ error: "bad" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const badConfig = await postSynthesis(
      makeEnv({ VOXCPM2_MODAL_ENDPOINT: "https://example.com/synthesize" }),
    );
    expect(badConfig.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();

    const badUpstream = await postSynthesis(makeEnv());
    expect(badUpstream.status).toBe(502);
  });
});
