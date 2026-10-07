import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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
const ATHANLAB_SECRET = btoa("k".repeat(32));

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
    VOXCPM2_MODAL_JOBS_URL: "https://owner--next-editor-voxcpm2-jobs.modal.run",
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

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const JOBS_URL = "https://owner--next-editor-voxcpm2-jobs.modal.run";
const CALL_ID = "fc-01TESTJOB";
const WAV = new Uint8Array([82, 73, 70, 70]);

function wavResponse(): Response {
  return new Response(WAV.slice().buffer, {
    status: 200,
    headers: { "Content-Type": "audio/wav" },
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pendingResponse(): Response {
  return jsonResponse({ status: "pending" }, 202);
}

/**
 * Stand in for the Modal jobs app: POST /jobs answers with `submit`, each
 * GET /jobs/{id} with the next entry of `polls` (which may throw, like a
 * dropped connection), DELETE with 204.
 */
function stubModal({
  submit = () => jsonResponse({ call_id: CALL_ID }, 202),
  polls = [wavResponse],
}: { submit?: () => Response; polls?: Array<() => Response> } = {}) {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const queue = [...polls];
  const fetchSpy = vi.fn<FetchFn>(async (_input, init) => {
    switch (init?.method) {
      case "POST":
        return submit();
      case "GET": {
        const next = queue.shift();
        if (!next) throw new Error("unexpected extra poll");
        return next();
      }
      case "DELETE":
        return new Response(null, { status: 204 });
      default:
        throw new Error(`unexpected ${init?.method} request`);
    }
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function callsWith(fetchSpy: ReturnType<typeof vi.fn<FetchFn>>, method: string) {
  return fetchSpy.mock.calls.filter(([, init]) => init?.method === method);
}

/** Run a request whose polls sleep between attempts, on fake timers. */
async function withFakeTimers(run: () => Response | Promise<Response>): Promise<Response> {
  vi.useFakeTimers();
  let settled = false;
  const response = Promise.resolve(run());
  response.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) await vi.advanceTimersByTimeAsync(1_000);
  return response;
}

afterEach(() => {
  vi.useRealTimers();
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
    expect(await enabled.json()).toEqual({ burmeseVoxCpm2: true, athanlab: false });

    const disabled = await request("/capabilities", makeEnv({ DB: dbWithAccess(USER, false) }));
    expect(await disabled.json()).toEqual({ burmeseVoxCpm2: false, athanlab: false });

    const unconfigured = await request(
      "/capabilities",
      makeEnv({ MODAL_PROXY_TOKEN_SECRET: undefined }),
    );
    expect(await unconfigured.json()).toEqual({ burmeseVoxCpm2: false, athanlab: false });

    // A Worker configured only for the retired synchronous endpoint is not ready.
    const legacyOnly = await request(
      "/capabilities",
      makeEnv({ VOXCPM2_MODAL_JOBS_URL: undefined }),
    );
    expect(await legacyOnly.json()).toEqual({ burmeseVoxCpm2: false, athanlab: false });
  });

  it("exposes AthanLab to every signed-in user once the key vault secret is valid", async () => {
    const configured = await request(
      "/capabilities",
      makeEnv({ DB: dbWithAccess(USER, false), ATHANLAB_KEY_ENCRYPTION_SECRET: ATHANLAB_SECRET }),
    );
    expect(await configured.json()).toEqual({ burmeseVoxCpm2: false, athanlab: true });

    // Anything but base64 of exactly 32 bytes leaves AthanLab off (fails closed).
    const malformed = await request(
      "/capabilities",
      makeEnv({ ATHANLAB_KEY_ENCRYPTION_SECRET: btoa("x".repeat(16)) }),
    );
    expect(await malformed.json()).toEqual({ burmeseVoxCpm2: true, athanlab: false });
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

  it("accepts a maximum-length reference clip and rejects miscoded base64", async () => {
    const fetchSpy = stubModal();

    // A 20s clip is the ~1.28 MB body that tripped the Worker CPU limit, so it
    // has to survive validation rather than be rejected or time out.
    const longest = synthesisBody({ referenceAudioBase64: referenceAudioBase64(20) });
    expect((await postSynthesis(makeEnv(), longest)).status).toBe(200);
    expect(callsWith(fetchSpy, "POST")).toHaveLength(1);

    const tooLong = synthesisBody({ referenceAudioBase64: referenceAudioBase64(21) });
    expect((await postSynthesis(makeEnv(), tooLong)).status).toBe(400);

    // Same decoded bytes, non-canonical trailing bits: a plain charset test
    // accepts this, so what we validated would not be what Modal decodes.
    const nonCanonical = synthesisBody({
      referenceAudioBase64: `${REFERENCE_AUDIO_BASE64.slice(0, -2)}B=`,
    });
    expect((await postSynthesis(makeEnv(), nonCanonical)).status).toBe(400);

    // Whitespace keeping the length a multiple of 4, which atob decodes anyway.
    const spaced = synthesisBody({
      referenceAudioBase64: `${REFERENCE_AUDIO_BASE64.slice(0, 8)}    ${REFERENCE_AUDIO_BASE64.slice(8)}`,
    });
    expect((await postSynthesis(makeEnv(), spaced)).status).toBe(400);

    expect(callsWith(fetchSpy, "POST")).toHaveLength(1);
  });

  it("submits only validated text, seed, reference audio, and proxy credentials, then polls the job", async () => {
    const fetchSpy = stubModal();

    const response = await postSynthesis(makeEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WAV);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [submitUrl, submitInit] = fetchSpy.mock.calls[0];
    expect(String(submitUrl)).toBe(`${JOBS_URL}/jobs`);
    expect(submitInit?.method).toBe("POST");
    expect(submitInit?.headers).toMatchObject({
      "Modal-Key": "wk-test",
      "Modal-Secret": "ws-test",
    });
    expect(submitInit?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(submitInit?.body))).toEqual({
      text: "မင်္ဂလာပါ။",
      seed: 42,
      reference_audio_base64: REFERENCE_AUDIO_BASE64,
    });

    const [pollUrl, pollInit] = fetchSpy.mock.calls[1];
    expect(String(pollUrl)).toBe(`${JOBS_URL}/jobs/${CALL_ID}`);
    expect(pollInit?.method).toBe("GET");
    expect(pollInit?.headers).toMatchObject({
      "Modal-Key": "wk-test",
      "Modal-Secret": "ws-test",
    });
    expect(pollInit?.signal).toBeInstanceOf(AbortSignal);
    expect(pollInit?.body).toBeUndefined();
  });

  it("keeps polling a pending job until its audio is ready", async () => {
    const fetchSpy = stubModal({ polls: [pendingResponse, pendingResponse, wavResponse] });

    const response = await withFakeTimers(() => postSynthesis(makeEnv()));

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WAV);
    expect(callsWith(fetchSpy, "POST")).toHaveLength(1);
    expect(callsWith(fetchSpy, "GET")).toHaveLength(3);
    expect(callsWith(fetchSpy, "DELETE")).toHaveLength(0);
  });

  it("polls the same job again after a dropped connection or a Cloudflare 524", async () => {
    const fetchSpy = stubModal({
      polls: [
        () => {
          throw new TypeError("network connection lost");
        },
        () => new Response("error code: 524", { status: 524 }),
        wavResponse,
      ],
    });

    const response = await withFakeTimers(() => postSynthesis(makeEnv()));

    expect(response.status).toBe(200);
    expect(callsWith(fetchSpy, "POST")).toHaveLength(1);
    expect(callsWith(fetchSpy, "DELETE")).toHaveLength(0);
    expect(callsWith(fetchSpy, "GET").map(([url]) => String(url))).toEqual([
      `${JOBS_URL}/jobs/${CALL_ID}`,
      `${JOBS_URL}/jobs/${CALL_ID}`,
      `${JOBS_URL}/jobs/${CALL_ID}`,
    ]);
  });

  it("gives up after three consecutive failed polls and cancels the job", async () => {
    const fetchSpy = stubModal({
      polls: [
        () => new Response("error code: 524", { status: 524 }),
        pendingResponse,
        () => new Response("error code: 524", { status: 524 }),
        () => {
          throw new TypeError("network connection lost");
        },
        () => new Response("Service Unavailable", { status: 503 }),
      ],
    });

    const response = await withFakeTimers(() => postSynthesis(makeEnv()));

    // The pending poll in between resets the count, so only the last three
    // failures in a row end the wait.
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Burmese narration service failed with HTTP 503",
    });
    expect(callsWith(fetchSpy, "GET")).toHaveLength(5);
    expect(callsWith(fetchSpy, "DELETE")).toHaveLength(1);
  });

  it("cancels a job that outlives the wait and stays within the subrequest budget", async () => {
    const fetchSpy = stubModal({ polls: Array.from({ length: 100 }, () => pendingResponse) });

    const response = await withFakeTimers(() => postSynthesis(makeEnv()));

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error:
        "Burmese narration did not finish within 280 s, so the job was cancelled; start the render again",
    });
    const cancels = callsWith(fetchSpy, "DELETE");
    expect(cancels).toHaveLength(1);
    expect(String(cancels[0][0])).toBe(`${JOBS_URL}/jobs/${CALL_ID}`);
    expect(cancels[0][1]?.headers).toMatchObject({ "Modal-Key": "wk-test" });
    // Workers Free allows 50 external subrequests per invocation.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(50);
  });

  it("rejects a submit response without a well-formed job id", async () => {
    for (const body of [{}, { call_id: "../../admin" }, { call_id: 7 }]) {
      const fetchSpy = stubModal({ submit: () => jsonResponse(body, 202) });

      const response = await postSynthesis(makeEnv());

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "Burmese narration service returned no synthesis job",
      });
      expect(callsWith(fetchSpy, "GET")).toHaveLength(0);
    }
  });

  it("rejects a non-Modal jobs URL and an unexpected job result", async () => {
    const fetchSpy = stubModal({ polls: [() => jsonResponse({ error: "bad" }, 200)] });

    for (const jobsUrl of [
      "https://example.com/",
      "http://owner--next-editor-voxcpm2-jobs.modal.run/",
      "https://owner--next-editor-voxcpm2-jobs.modal.run/jobs",
    ]) {
      const badConfig = await postSynthesis(makeEnv({ VOXCPM2_MODAL_JOBS_URL: jobsUrl }));
      expect(badConfig.status).toBe(503);
    }
    expect(fetchSpy).not.toHaveBeenCalled();

    const badUpstream = await postSynthesis(makeEnv());
    expect(badUpstream.status).toBe(502);
    expect(await badUpstream.json()).toEqual({
      error: 'Burmese narration service returned "application/json" instead of audio/wav',
    });
  });

  it("forwards Modal's FastAPI error detail from a submit or a poll", async () => {
    stubModal({
      submit: () =>
        new Response(JSON.stringify({ detail: "reference audio must be a valid WAV" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Set-Cookie": "modal=1" },
        }),
    });

    const rejected = await postSynthesis(makeEnv());

    expect(rejected.status).toBe(502);
    expect(rejected.headers.get("set-cookie")).toBeNull();
    expect(await rejected.json()).toEqual({
      error: "Burmese narration service failed with HTTP 400: reference audio must be a valid WAV",
    });

    const fetchSpy = stubModal({
      polls: [() => jsonResponse({ detail: "VoxCPM2 generation failed: OutOfMemoryError" }, 500)],
    });

    const failed = await postSynthesis(makeEnv());
    expect(callsWith(fetchSpy, "DELETE")).toHaveLength(1);

    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({
      error:
        "Burmese narration service failed with HTTP 500: VoxCPM2 generation failed: OutOfMemoryError",
    });
  });

  it("redacts credentials and bounds a plain-text upstream error", async () => {
    stubModal({
      submit: () =>
        new Response(
          `boom\n\tModal-Secret ws-test from owner--next-editor-voxcpm2-jobs.modal.run ws-abcdefghijkl ${"x".repeat(500)}`,
          { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } },
        ),
    });

    const { error } = (await (await postSynthesis(makeEnv())).json()) as { error: string };

    expect(error).toMatch(
      /^Burmese narration service failed with HTTP 500: boom Modal-Secret \[redacted\] from \[redacted\] \[redacted\] x+…$/,
    );
    expect(error).not.toContain("ws-");
    expect(error).not.toContain("modal.run");
    expect(error.length).toBeLessThan(300);
  });

  it("reports only the status for an HTML or oversized upstream error", async () => {
    stubModal({
      submit: () =>
        new Response("<html><body>524: A timeout occurred</body></html>", {
          status: 524,
          headers: { "Content-Type": "text/html" },
        }),
    });
    expect(await (await postSynthesis(makeEnv())).json()).toEqual({
      error: "Burmese narration service failed with HTTP 524",
    });

    stubModal({
      submit: () =>
        new Response("y".repeat(5_000), {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }),
    });
    expect(await (await postSynthesis(makeEnv())).json()).toEqual({
      error: "Burmese narration service failed with HTTP 500",
    });
  });

  it("releases an upstream error body refused by its Content-Length", async () => {
    const cancel = vi.fn<() => void>();
    const body = new ReadableStream<Uint8Array>({ cancel });
    stubModal({
      submit: () =>
        new Response(body, {
          status: 500,
          headers: { "Content-Type": "text/plain", "Content-Length": "5000" },
        }),
    });

    expect(await (await postSynthesis(makeEnv())).json()).toEqual({
      error: "Burmese narration service failed with HTTP 500",
    });
    expect(cancel).toHaveBeenCalled();
  });
});
