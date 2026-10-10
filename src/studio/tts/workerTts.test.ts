import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DROPPED_CONNECTION_ATTEMPTS, postStudioTtsWav, retryDroppedConnection } from "./workerTts";

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("postStudioTtsWav", () => {
  it("posts the body to the provider's same-origin route and returns the WAV bytes", async () => {
    const fetchSpy = vi.fn<FetchMock>(
      async () =>
        new Response(new Uint8Array([82, 73, 70, 70]).buffer, {
          status: 200,
          headers: { "Content-Type": "audio/wav; charset=binary" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await postStudioTtsWav("voxcpm2", '{"text":"hi"}');

    expect(result).toEqual({ kind: "audio", bytes: new Uint8Array([82, 73, 70, 70]) });
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith("/api/studio/tts/voxcpm2", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "audio/wav", "Content-Type": "application/json" },
      body: '{"text":"hi"}',
    });
  });

  it("reads the Worker's error payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(
        async () =>
          new Response(
            JSON.stringify({
              error: "still going",
              code: "still_processing",
              retryAfterSeconds: 7,
            }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    expect(await postStudioTtsWav("athanlab", "{}")).toEqual({
      kind: "error",
      status: 503,
      detail: "still going",
      code: "still_processing",
      retryAfterSeconds: 7,
    });
  });

  it("names the status when the error body is not a payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () => new Response("<html>bad gateway</html>", { status: 502 })),
    );

    expect(await postStudioTtsWav("athanlab", "{}")).toEqual({
      kind: "error",
      status: 502,
      detail: "request failed with HTTP 502",
      code: null,
      retryAfterSeconds: undefined,
    });
  });

  it("flags a successful response that is not a WAV", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(
        async () =>
          new Response("not audio", { status: 200, headers: { "Content-Type": "text/plain" } }),
      ),
    );

    expect(await postStudioTtsWav("voxcpm2", "{}")).toEqual({ kind: "not-wav" });
  });
});

describe("retryDroppedConnection", () => {
  it("tries three times, 2 s then 5 s apart, then names the failure", async () => {
    vi.useFakeTimers();
    const run = vi.fn<() => Promise<string>>(async () => {
      throw new TypeError("Failed to fetch");
    });

    const failure = retryDroppedConnection(
      run,
      (error) => new Error(`gave up: ${error.message}`),
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(DROPPED_CONNECTION_ATTEMPTS);
    expect(((await failure) as Error).message).toBe("gave up: Failed to fetch");
  });

  it("returns the first answer, and never retries any other failure", async () => {
    vi.useFakeTimers();
    const recovered = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce("take");
    const result = retryDroppedConnection(recovered, () => new Error("unused"));
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe("take");
    expect(recovered).toHaveBeenCalledTimes(2);

    const refused = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("not enabled"));
    await expect(retryDroppedConnection(refused, () => new Error("unused"))).rejects.toThrow(
      "not enabled",
    );
    expect(refused).toHaveBeenCalledOnce();
  });
});
