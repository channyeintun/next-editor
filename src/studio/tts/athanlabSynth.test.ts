import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AthanLabSynthesisError, synthesizeAthanLabWav } from "./athanlabSynth";
import { athanLabProfileOf } from "./profiles";
import { decodeWavPcm16, encodeWavPcm16, floatTo16BitPcm } from "./wav";

const PROFILE = athanLabProfileOf("voice_01");
const CONTINUE_HINT =
  " — dialogs already synthesized are kept, so rendering again continues where this stopped.";

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** One second of a voiced 24 kHz tone, as AthanLab might return it. */
function athanLabWav(): Uint8Array {
  const samples = new Float32Array(24_000);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 24_000);
  }
  return encodeWavPcm16(floatTo16BitPcm(samples), 24_000);
}

function wavResponse(): Response {
  return new Response(athanLabWav().slice().buffer, {
    status: 200,
    headers: { "Content-Type": "audio/wav" },
  });
}

function errorResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stillProcessing(retryAfterSeconds?: number): Response {
  return errorResponse(503, {
    error: "AthanLab is still generating this dialog",
    code: "still_processing",
    retryAfterSeconds,
  });
}

/** Settle into a value first: a bare rejection would go unhandled while fake timers run. */
function settled(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

describe("synthesizeAthanLabWav", () => {
  it("posts the prepared text and voice to the same-origin Worker route", async () => {
    const fetchSpy = vi.fn<FetchMock>(async () => wavResponse());
    vi.stubGlobal("fetch", fetchSpy);

    await synthesizeAthanLabWav(PROFILE, `"Rust" ကို ကြည့်ရအောင်`);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/studio/tts/athanlab");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "audio/wav", "Content-Type": "application/json" },
    });
    expect(init?.body).toBe(JSON.stringify({ text: "Rust ကို ကြည့်ရအောင်။", voiceId: "voice_01" }));
  });

  it("returns the take as 16-bit PCM mono at the profile's rate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () => wavResponse()),
    );

    const { pcm, sampleRate } = decodeWavPcm16(await synthesizeAthanLabWav(PROFILE, "မင်္ဂလာပါ။"));

    expect(sampleRate).toBe(48_000);
    expect(pcm.length).toBeGreaterThan(47_000);
    expect(pcm.length).toBeLessThanOrEqual(48_000);
  });

  it("asks again after a dropped connection, with the same request", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .fn<FetchMock>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(wavResponse());
    vi.stubGlobal("fetch", fetchSpy);

    const result = settled(synthesizeAthanLabWav(PROFILE, "စာသား"));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await result).toBeInstanceOf(Uint8Array);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[2][1]?.body).toBe(fetchSpy.mock.calls[0][1]?.body);
  });

  it("gives up after three dropped connections", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn<FetchMock>(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const failure = settled(synthesizeAthanLabWav(PROFILE, "စာသား"));
    await vi.runAllTimersAsync();

    expect(((await failure) as Error).message).toBe(
      `AthanLab: the connection failed 3 times (Failed to fetch)${CONTINUE_HINT}`,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("re-attaches to a job that is still processing, waiting as the Worker asks", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .fn<FetchMock>()
      .mockResolvedValueOnce(stillProcessing(3))
      .mockResolvedValueOnce(stillProcessing())
      .mockResolvedValueOnce(wavResponse());
    vi.stubGlobal("fetch", fetchSpy);

    const result = settled(synthesizeAthanLabWav(PROFILE, "စာသား"));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // No retryAfterSeconds: the default 5 s.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toBeInstanceOf(Uint8Array);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(new Set(fetchSpy.mock.calls.map(([, init]) => init?.body)).size).toBe(1);
  });

  it("stops after four more requests while the job is still processing", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn<FetchMock>(async () => stillProcessing(5));
    vi.stubGlobal("fetch", fetchSpy);

    const failure = settled(synthesizeAthanLabWav(PROFILE, "စာသား"));
    await vi.runAllTimersAsync();

    const error = (await failure) as AthanLabSynthesisError;
    expect(error.message).toBe(`AthanLab is still generating this dialog${CONTINUE_HINT}`);
    expect(error.code).toBe("still_processing");
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it("waits out this user's per-minute budget, then asks again", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .fn<FetchMock>()
      .mockResolvedValueOnce(
        errorResponse(429, {
          error: "Too many AthanLab requests — wait a minute",
          code: "rate_limited",
          retryAfterSeconds: 60,
        }),
      )
      .mockResolvedValueOnce(wavResponse());
    vi.stubGlobal("fetch", fetchSpy);

    const result = settled(synthesizeAthanLabWav(PROFILE, "စာသား"));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toBeInstanceOf(Uint8Array);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("gives up after three more requests while the budget stays spent", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn<FetchMock>(async () =>
      errorResponse(429, {
        error: "Too many AthanLab requests — wait a minute",
        code: "rate_limited",
        retryAfterSeconds: 60,
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const failure = settled(synthesizeAthanLabWav(PROFILE, "စာသား"));
    await vi.runAllTimersAsync();

    const error = (await failure) as AthanLabSynthesisError;
    expect(error.message).toBe(
      `AthanLab: Too many AthanLab requests — wait a minute${CONTINUE_HINT}`,
    );
    expect(error.code).toBe("rate_limited");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("asks again while another request is checking the saved key", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .fn<FetchMock>()
      .mockResolvedValueOnce(
        errorResponse(503, {
          error: "AthanLab is checking your saved key",
          code: "key_busy",
          retryAfterSeconds: 2,
        }),
      )
      .mockResolvedValueOnce(wavResponse());
    vi.stubGlobal("fetch", fetchSpy);

    const result = settled(synthesizeAthanLabWav(PROFILE, "စာသား"));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await result).toBeInstanceOf(Uint8Array);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries a retry-later code only with the status it comes with", async () => {
    const fetchSpy = vi.fn<FetchMock>(async () =>
      errorResponse(502, { error: "Upstream refused", code: "rate_limited" }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(synthesizeAthanLabWav(PROFILE, "စာသား")).rejects.toThrow(
      `AthanLab: Upstream refused${CONTINUE_HINT}`,
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each(["constructor", "__proto__", "toString"])(
    "treats the code %s as an ordinary error, not an inherited message",
    async (code) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<FetchMock>(async () => errorResponse(502, { error: "Upstream refused", code })),
      );

      const error = (await settled(
        synthesizeAthanLabWav(PROFILE, "စာသား"),
      )) as AthanLabSynthesisError;

      expect(error.message).toBe(`AthanLab: Upstream refused${CONTINUE_HINT}`);
      expect(error.code).toBe(code);
    },
  );

  it("surfaces a Worker error once, prefixed only when it does not name AthanLab", async () => {
    const fetchSpy = vi
      .fn<FetchMock>()
      .mockResolvedValueOnce(
        errorResponse(502, {
          error: "This key has used its monthly character budget",
          code: "key_budget_exceeded",
        }),
      )
      .mockResolvedValueOnce(
        errorResponse(503, { error: "AthanLab: Service is busy", code: "server_busy" }),
      )
      .mockResolvedValueOnce(new Response("<html>Bad gateway</html>", { status: 502 }));
    vi.stubGlobal("fetch", fetchSpy);

    const first = (await settled(
      synthesizeAthanLabWav(PROFILE, "စာသား"),
    )) as AthanLabSynthesisError;
    expect(first).toBeInstanceOf(AthanLabSynthesisError);
    expect(first.message).toBe(
      `AthanLab: This key has used its monthly character budget${CONTINUE_HINT}`,
    );
    expect(first.code).toBe("key_budget_exceeded");

    await expect(synthesizeAthanLabWav(PROFILE, "စာသား")).rejects.toThrow(
      `AthanLab: Service is busy${CONTINUE_HINT}`,
    );
    await expect(synthesizeAthanLabWav(PROFILE, "စာသား")).rejects.toThrow(
      `AthanLab: request failed with HTTP 502${CONTINUE_HINT}`,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["key_missing", /connect your key/],
    ["key_invalid", /rejected your saved API key .* Connect a new key/],
    ["key_stale", /can no longer be read — connect it again/],
  ])("asks the user to reconnect the key on %s", async (code, message) => {
    const fetchSpy = vi.fn<FetchMock>(async () =>
      errorResponse(409, { error: "server wording", code }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const error = (await settled(
      synthesizeAthanLabWav(PROFILE, "စာသား"),
    )) as AthanLabSynthesisError;

    expect(error.message).toMatch(message);
    expect(error.message).toMatch(/^AthanLab: .*render again\.$/);
    expect(error.message).not.toContain("dialogs already synthesized");
    expect(error.code).toBe(code);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("rejects a successful non-WAV response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(
        async () =>
          new Response("not audio", { status: 200, headers: { "Content-Type": "text/plain" } }),
      ),
    );

    await expect(synthesizeAthanLabWav(PROFILE, "စာသား")).rejects.toThrow("non-WAV response");
  });

  it("names unreadable audio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(
        async () =>
          new Response("RIFF....", { status: 200, headers: { "Content-Type": "audio/wav" } }),
      ),
    );

    await expect(synthesizeAthanLabWav(PROFILE, "စာသား")).rejects.toThrow(
      "AthanLab: the returned audio could not be read (Not a RIFF/WAVE file)",
    );
  });

  it("refuses text it cannot send, without a request", async () => {
    const fetchSpy = vi.fn<FetchMock>();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(synthesizeAthanLabWav(PROFILE, ` "" () `)).rejects.toThrow(
      "this dialog has nothing to speak",
    );
    await expect(synthesizeAthanLabWav(PROFILE, "က".repeat(5_000))).rejects.toThrow(
      /this dialog is 5001 characters long/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
