import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SavedCustomVoice } from "./customVoices";
import { HOWARD_SERVER_NOT_REPORTED } from "./howard/server";
import { howardProfileOf } from "./profiles";
import { decodeWavPcm16, encodeWavPcm16 } from "./wav";

const voiceStore = vi.hoisted(() => ({
  getCustomVoice: vi.fn<(id: string) => Promise<SavedCustomVoice | null>>(),
}));

vi.mock("./customVoices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./customVoices")>();
  return { ...actual, getCustomVoice: voiceStore.getCustomVoice };
});

const SERVER = "http://127.0.0.1:8080";
const MODEL = "Howard-0.6B-Q8_0.gguf";
const SAMPLES_PER_FRAME = 1_920;

const SAVED_VOICE: SavedCustomVoice = {
  id: "voice-1",
  name: "Narrator",
  createdAtIso: "2026-11-25T00:00:00.000Z",
  sampleRate: 24_000,
  samples: new Float32Array(24_000 * 5),
  sampleSha256: "ab".repeat(32),
};
const PROFILE = howardProfileOf(SAVED_VOICE, MODEL);
const VOICE_NAME = `ne-${"ab".repeat(16)}`;

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

type Answer = (call: Call) => Response | undefined;

/** A take of `frames` codec frames with a voiced middle, as the server returns one. */
function takeOf(frames: number): Uint8Array {
  const pcm = new Int16Array(frames * SAMPLES_PER_FRAME);
  pcm.fill(8_000, SAMPLES_PER_FRAME, pcm.length - SAMPLES_PER_FRAME);
  return encodeWavPcm16(pcm, 24_000);
}

function wavResponse(frames = 20): Response {
  return new Response(takeOf(frames).slice().buffer, {
    status: 200,
    headers: { "Content-Type": "audio/wav" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub fetch with a Howard server: `answer` overrides its default replies. */
function stubServer(answer: Answer = () => undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe(SERVER);
        const call: Call = {
          method: init?.method ?? "GET",
          path: url.pathname,
          body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
        };
        calls.push(call);
        const overridden = answer(call);
        if (overridden) return overridden;
        if (call.path === "/v1/models") return json({ object: "list", data: [{ id: MODEL }] });
        if (call.path === "/v1/audio/voices") return json({ name: VOICE_NAME });
        return wavResponse();
      },
    ),
  );
  return calls;
}

/** The module afresh, so each test starts with no voice registered. */
async function loadSynth() {
  vi.resetModules();
  return import("./howardSynth");
}

beforeEach(() => {
  localStorage.clear();
  voiceStore.getCustomVoice.mockReset().mockResolvedValue(SAVED_VOICE);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("synthesizeHowardDialog", () => {
  it("registers the reference once, then speaks each dialog in that voice", async () => {
    const calls = stubServer();
    const { synthesizeHowardDialog } = await loadSynth();

    const first = await synthesizeHowardDialog(PROFILE, "  မင်္ဂလာပါ။ ", 42);
    await synthesizeHowardDialog(PROFILE, "နောက်တစ်ကြောင်း။", 42);

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v1/audio/voices",
      "POST /v1/audio/speech",
      "POST /v1/audio/speech",
    ]);
    const registration = calls[0].body;
    expect(registration?.name).toBe(VOICE_NAME);
    expect(atob(String(registration?.wav_b64)).slice(0, 4)).toBe("RIFF");
    // No transcript: the stock runtime speaks unrelated words with one.
    expect(registration).not.toHaveProperty("ref_text");
    expect(calls[1].body).toEqual({
      input: "မင်္ဂလာပါ။",
      voice: VOICE_NAME,
      language: "auto",
      response_format: "wav",
      seed: 42,
      max_new_tokens: 125 + 3 * "မင်္ဂလာပါ။".length,
      temperature: 0.65,
      top_p: 0.9,
      subtalker_temperature: 0.15,
    });
    expect(first.hitFrameCap).toBe(false);
    expect(decodeWavPcm16(first.wav).sampleRate).toBe(24_000);
  });

  it("registers the voice again when a restarted server has forgotten it", async () => {
    let speeches = 0;
    const calls = stubServer((call) => {
      if (call.path !== "/v1/audio/speech") return undefined;
      speeches += 1;
      return speeches === 1
        ? json({ error: { message: `unknown voice '${VOICE_NAME}'` } }, 400)
        : undefined;
    });
    const { synthesizeHowardDialog } = await loadSynth();

    await synthesizeHowardDialog(PROFILE, "မင်္ဂလာပါ။", 1);

    expect(calls.map((call) => call.path)).toEqual([
      "/v1/audio/voices",
      "/v1/audio/speech",
      "/v1/audio/voices",
      "/v1/audio/speech",
    ]);
  });

  it("flags a take that ran to its frame cap", async () => {
    const text = "က".repeat(10);
    stubServer((call) => (call.path === "/v1/audio/speech" ? wavResponse(155) : undefined));
    const { synthesizeHowardDialog } = await loadSynth();

    expect((await synthesizeHowardDialog(PROFILE, text, 1)).hitFrameCap).toBe(true);
  });

  it("passes the server's own refusal on", async () => {
    stubServer((call) =>
      call.path === "/v1/audio/speech"
        ? json({ error: { message: "'input' must be a non-empty string" } }, 400)
        : undefined,
    );
    const { synthesizeHowardDialog } = await loadSynth();

    await expect(synthesizeHowardDialog(PROFILE, "မင်္ဂလာပါ။", 1)).rejects.toThrow(
      "Howard: 'input' must be a non-empty string",
    );
  });

  it("says the server is not running when nothing answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const { synthesizeHowardDialog } = await loadSynth();

    await expect(synthesizeHowardDialog(PROFILE, "မင်္ဂလာပါ။", 1)).rejects.toThrow(
      `Howard: no server answers at ${SERVER}`,
    );
  });

  it("refuses a reference that is no longer in this browser", async () => {
    stubServer();
    voiceStore.getCustomVoice.mockResolvedValue(null);
    const { synthesizeHowardDialog } = await loadSynth();

    await expect(synthesizeHowardDialog(PROFILE, "မင်္ဂလာပါ။", 1)).rejects.toThrow(
      'Reference voice "voice-1" is not in this browser',
    );
  });

  it("calls the address the author stored", async () => {
    localStorage.setItem("next-editor:studio:howard-server-url", "http://localhost:9000");
    const origins: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<(input: string | URL | Request) => Promise<Response>>(async (input) => {
        const url = new URL(String(input));
        origins.push(url.origin);
        return url.pathname === "/v1/audio/voices" ? json({ name: VOICE_NAME }) : wavResponse();
      }),
    );
    const { synthesizeHowardDialog } = await loadSynth();

    await synthesizeHowardDialog(PROFILE, "မင်္ဂလာပါ။", 1);

    expect(origins).toEqual(["http://localhost:9000", "http://localhost:9000"]);
  });
});

describe("howardSynthProvider", () => {
  it("checks the server's model and registers the narrator before the first dialog", async () => {
    const calls = stubServer();
    const { howardSynthProvider } = await loadSynth();
    const provider = howardSynthProvider(PROFILE, 7);

    await provider.preload();
    const take = await provider.synthesize("မင်္ဂလာပါ။");

    expect(calls.map((call) => call.path)).toEqual([
      "/v1/models",
      "/v1/audio/voices",
      "/v1/audio/speech",
    ]);
    expect(calls[2].body?.seed).toBe(7);
    expect(provider.seed).toBe(7);
    expect(provider.sampleRate).toBe(24_000);
    expect(take.hitFrameCap).toBe(false);
  });

  it("stops the build when the server now runs another talker", async () => {
    stubServer((call) =>
      call.path === "/v1/models" ? json({ data: [{ id: "Howard-0.6B-Q4_K_M.gguf" }] }) : undefined,
    );
    const { howardSynthProvider } = await loadSynth();

    await expect(howardSynthProvider(PROFILE, 7).preload()).rejects.toThrow(
      `now runs "Howard-0.6B-Q4_K_M.gguf", not "${MODEL}"`,
    );
  });

  it("trims the silence around a take without changing its rate", async () => {
    const { howardSynthProvider } = await loadSynth();
    const prepared = decodeWavPcm16(howardSynthProvider(PROFILE, 7).prepareTake(takeOf(20)));

    expect(prepared.sampleRate).toBe(24_000);
    expect(prepared.pcm.length).toBeLessThan(20 * SAMPLES_PER_FRAME);
    expect(prepared.pcm.length).toBeGreaterThanOrEqual(18 * SAMPLES_PER_FRAME);
  });
});

describe("howardNarrationProfileOf", () => {
  it("keys the narrator by the model the server named", async () => {
    const { howardNarrationProfileOf } = await loadSynth();

    expect(
      howardNarrationProfileOf(SAVED_VOICE, { modelId: MODEL, reachable: false, reason: "off" }),
    ).toEqual(PROFILE);
  });

  it("says what is missing: a model, then a reference", async () => {
    const { howardNarrationProfileOf } = await loadSynth();
    const server = { modelId: MODEL, reachable: true, reason: null };

    expect(() => howardNarrationProfileOf(SAVED_VOICE, HOWARD_SERVER_NOT_REPORTED)).toThrow(
      "Checking the Howard server",
    );
    expect(() => howardNarrationProfileOf(null, server)).toThrow("3–20s narrator reference");
    expect(() =>
      howardNarrationProfileOf({ ...SAVED_VOICE, samples: new Float32Array(24_000 * 2) }, server),
    ).toThrow("3–20s narrator reference");
  });
});
