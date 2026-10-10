// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { loadWhisperAssets } from "./whisperAssets";

const FILES: Record<string, Uint8Array> = {
  "encoder_model_quantized.onnx": Uint8Array.from({ length: 40 }, (_, index) => index),
  "decoder_model_merged_quantized.onnx": Uint8Array.from({ length: 64 }, (_, index) => 255 - index),
  "config.json": new TextEncoder().encode('{"vocab_size":3}'),
  "generation_config.json": new TextEncoder().encode('{"suppress_tokens":[]}'),
  "tokenizer.json": new TextEncoder().encode('{"added_tokens":[]}'),
};

const fileOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

/** A body that delivers `bytes` and then drops the connection. */
function droppingBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let pulls = 0;
  return new ReadableStream({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(bytes);
      else controller.error(new TypeError("network error"));
    },
  });
}

function serve(
  handle?: (file: string, range: string | null, call: number) => Response | undefined,
) {
  const calls: Array<{ file: string; range: string | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const file = fileOf(url);
      const range = new Headers(init?.headers).get("range");
      calls.push({ file, range });
      const call = calls.filter((entry) => entry.file === file).length;
      return handle?.(file, range, call) ?? new Response(FILES[file].slice());
    }),
  );
  return calls;
}

/** Runs a load to the end, retry delays included. */
async function load() {
  const pending = loadWhisperAssets();
  pending.catch(() => {});
  await vi.runAllTimersAsync();
  return pending;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("loadWhisperAssets", () => {
  it("resumes a dropped download from the bytes it already has", async () => {
    vi.useFakeTimers();
    const decoder = FILES["decoder_model_merged_quantized.onnx"];
    const calls = serve((file, range, call) => {
      if (file !== "decoder_model_merged_quantized.onnx") return undefined;
      if (call === 1) return new Response(droppingBody(decoder.slice(0, 24)));
      return new Response(decoder.slice(Number(range?.match(/bytes=(\d+)-/)?.[1])), {
        status: 206,
      });
    });

    const assets = await load();

    expect(new Uint8Array(assets.decoder)).toEqual(decoder);
    expect(new Uint8Array(assets.encoder)).toEqual(FILES["encoder_model_quantized.onnx"]);
    expect(assets.config).toEqual({ vocab_size: 3 });
    expect(calls.filter((entry) => entry.file === "decoder_model_merged_quantized.onnx")).toEqual([
      { file: "decoder_model_merged_quantized.onnx", range: null },
      { file: "decoder_model_merged_quantized.onnx", range: "bytes=24-" },
    ]);
  });

  it("starts over when the server ignores the range", async () => {
    vi.useFakeTimers();
    const encoder = FILES["encoder_model_quantized.onnx"];
    serve((file, _range, call) => {
      if (file !== "encoder_model_quantized.onnx") return undefined;
      if (call === 1) return new Response(droppingBody(encoder.slice(0, 10)));
      return new Response(encoder.slice());
    });

    const assets = await load();

    expect(new Uint8Array(assets.encoder)).toEqual(encoder);
  });

  it("caches each complete file and keeps the bytes it hands back whole", async () => {
    vi.useFakeTimers();
    const stored = new Map<string, ArrayBuffer>();
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async (url: string) => {
          const bytes = stored.get(url);
          return bytes ? new Response(bytes.slice(0)) : undefined;
        },
        put: async (url: string, response: Response) => {
          stored.set(url, await response.arrayBuffer());
        },
      }),
    });
    const calls = serve();

    const assets = await load();

    const decoder = FILES["decoder_model_merged_quantized.onnx"];
    expect(new Uint8Array(assets.decoder)).toEqual(decoder);
    const cachedDecoder = [...stored].find(
      ([url]) => fileOf(url) === "decoder_model_merged_quantized.onnx",
    )?.[1];
    expect(new Uint8Array(cachedDecoder!)).toEqual(decoder);

    // A second run reads the cache and downloads nothing.
    const downloads = calls.length;
    const cached = await load();
    expect(new Uint8Array(cached.decoder)).toEqual(decoder);
    expect(new Uint8Array(cached.encoder)).toEqual(FILES["encoder_model_quantized.onnx"]);
    expect(calls).toHaveLength(downloads);
  });

  it("does not retry a missing file", async () => {
    vi.useFakeTimers();
    const calls = serve((file) =>
      file === "tokenizer.json" ? new Response("", { status: 404 }) : undefined,
    );

    await expect(load()).rejects.toThrow("tokenizer.json: HTTP 404");
    expect(calls.filter((entry) => entry.file === "tokenizer.json")).toHaveLength(1);
  });

  it("gives up after a few dropped connections, with a readable reason", async () => {
    vi.useFakeTimers();
    const calls = serve((file) =>
      file === "encoder_model_quantized.onnx"
        ? new Response(droppingBody(new Uint8Array(0)))
        : undefined,
    );

    await expect(load()).rejects.toThrow("Check the connection and try again");
    expect(calls.filter((entry) => entry.file === "encoder_model_quantized.onnx")).toHaveLength(4);
  });
});
