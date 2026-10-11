import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PocketBundleMetadata } from "./bundleAssets";
import { PocketTtsEngine } from "./engine";
import type { VoiceRecord } from "./voicesBin";

interface FakeSession {
  name: string;
  release: () => Promise<void>;
}

const ort = vi.hoisted(() => ({
  sessions: [] as FakeSession[],
  create: vi.fn<(bytes: Uint8Array) => Promise<FakeSession>>(),
}));

const bundle = vi.hoisted(() => ({
  fetchBundleAsset: vi.fn<(baseUrl: string, filename: string) => Promise<ArrayBuffer>>(),
  voices: {} as Record<string, VoiceRecord>,
}));

vi.mock("onnxruntime-web/wasm", () => ({
  env: { wasm: {} },
  InferenceSession: { create: ort.create },
  Tensor: class {},
}));
vi.mock("./ortWasmAssets", () => ({
  ortWasmThreadedMjs: "ort.mjs",
  ortWasmThreadedWasm: "ort.wasm",
}));
vi.mock("./bundleAssets", () => ({
  fetchBundleAsset: bundle.fetchBundleAsset,
  fetchBundleMetadata: async (): Promise<Partial<PocketBundleMetadata>> => ({
    tokenizer_file: "tokenizer.model",
    insert_bos_before_voice: false,
    bos_before_voice_file: null,
    flow_lm_state_manifest: [],
  }),
}));
vi.mock("./vendor/sentencepiece.js", () => ({
  SentencePieceProcessor: class {
    async loadFromB64StringModel() {}
  },
}));
vi.mock("./voicesBin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./voicesBin")>()),
  parseVoiceStatesBin: () => bundle.voices,
}));

const MODELS = [
  "text_conditioner_int8.onnx",
  "flow_lm_main_int8.onnx",
  "flow_lm_flow_int8.onnx",
  "mimi_decoder_int8.onnx",
];

/** Serves every bundle file as its own name, failing the ones in `failing`. */
function serve(failing: string[] = []) {
  bundle.fetchBundleAsset.mockImplementation(async (_baseUrl, filename) => {
    if (failing.includes(filename)) {
      throw new Error(`Failed to fetch ${filename}: HTTP 503`);
    }
    return new TextEncoder().encode(filename).buffer;
  });
}

function load(voice = "alba", customVoiceSamples?: Float32Array) {
  return PocketTtsEngine.load({
    bundleBaseUrl: "https://assets.example/pocket",
    voice,
    customVoiceSamples,
  });
}

/** Lets session creates still in flight after a rejection finish. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function releaseCounts() {
  return Object.fromEntries(
    ort.sessions.map((session) => [session.name, vi.mocked(session.release).mock.calls.length]),
  );
}

beforeEach(() => {
  ort.sessions.length = 0;
  ort.create.mockReset().mockImplementation(async (bytes) => {
    const session = {
      name: new TextDecoder().decode(bytes),
      release: vi.fn<() => Promise<void>>(async () => {}),
    };
    ort.sessions.push(session);
    return session;
  });
  bundle.voices = { alba: {} };
});

describe("PocketTtsEngine.load", () => {
  it("keeps every session of a load that succeeds", async () => {
    serve();

    await load();

    expect(ort.sessions).toHaveLength(4);
    expect(Object.values(releaseCounts())).toEqual([0, 0, 0, 0]);
  });

  // A failed load is retried with a fresh engine, so sessions it leaves
  // unreleased hold their models in WASM memory until the tab reloads.
  it("releases the sessions it created when one model fails to download", async () => {
    serve(["flow_lm_flow_int8.onnx"]);

    await expect(load()).rejects.toThrow("Failed to fetch flow_lm_flow_int8.onnx");
    await settle();

    expect(releaseCounts()).toEqual({
      "text_conditioner_int8.onnx": 1,
      "flow_lm_main_int8.onnx": 1,
      "mimi_decoder_int8.onnx": 1,
    });
  });

  it("releases all four sessions when a later step fails", async () => {
    serve(["tokenizer.model"]);

    await expect(load()).rejects.toThrow("Failed to fetch tokenizer.model");
    await settle();

    expect(releaseCounts()).toEqual(Object.fromEntries(MODELS.map((model) => [model, 1])));
  });

  it("releases all four sessions when cloning a custom voice fails", async () => {
    serve(["mimi_encoder_int8.onnx"]);

    await expect(load("custom", new Float32Array(24_000))).rejects.toThrow(
      "Failed to fetch mimi_encoder_int8.onnx",
    );
    await settle();

    expect(releaseCounts()).toEqual(Object.fromEntries(MODELS.map((model) => [model, 1])));
  });

  it("releases all four sessions when the voice is not in the bundle", async () => {
    serve();

    await expect(load("nobody")).rejects.toThrow('Voice "nobody" not in bundle');
    await settle();

    expect(releaseCounts()).toEqual(Object.fromEntries(MODELS.map((model) => [model, 1])));
  });
});
