import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fetchBundleAsset } from "./bundleAssets";

const BASE = "https://assets.example/pocket";
const BYTES = Uint8Array.from({ length: 32 }, (_, index) => index);

function serve() {
  const fetchSpy = vi.fn<(url: string) => Promise<Response>>(
    async () => new Response(BYTES.slice()),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchBundleAsset", () => {
  it("downloads the asset where the cache cannot be opened", async () => {
    // Storage blocked (a private window, a denied context).
    vi.stubGlobal("caches", {
      open: () => Promise.reject(new DOMException("The operation is insecure.", "SecurityError")),
    });
    const fetchSpy = serve();

    const bytes = await fetchBundleAsset(BASE, "flow_lm_main_int8.onnx");

    expect(new Uint8Array(bytes)).toEqual(BYTES);
    expect(fetchSpy).toHaveBeenCalledWith(`${BASE}/flow_lm_main_int8.onnx`);
  });

  it("keeps the downloaded asset when the cache has no room for it", async () => {
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async () => undefined,
        put: async (_url: string, response: Response) => {
          await response.arrayBuffer();
          throw new DOMException("Quota exceeded.", "QuotaExceededError");
        },
      }),
    });
    const fetchSpy = serve();

    const bytes = await fetchBundleAsset(BASE, "mimi_decoder_int8.onnx");

    expect(new Uint8Array(bytes)).toEqual(BYTES);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns a cached asset without downloading it", async () => {
    const cached = Uint8Array.from([7, 8, 9]);
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async () => new Response(cached.slice()),
        put: async () => {},
      }),
    });
    const fetchSpy = serve();

    const bytes = await fetchBundleAsset(BASE, "bundle.json");

    expect(new Uint8Array(bytes)).toEqual(cached);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks again for a file whose connection dropped", async () => {
    vi.stubGlobal("caches", undefined);
    vi.useFakeTimers();
    const fetchSpy = vi
      .fn<(url: string) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(async () => new Response(BYTES.slice()));
    vi.stubGlobal("fetch", fetchSpy);

    const loading = fetchBundleAsset(BASE, "flow_lm_flow_int8.onnx");
    await vi.runAllTimersAsync();

    expect(new Uint8Array(await loading)).toEqual(BYTES);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("gives up on a file after a few tries and says what is kept", async () => {
    vi.stubGlobal("caches", undefined);
    vi.useFakeTimers();
    const fetchSpy = vi
      .fn<(url: string) => Promise<Response>>()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchSpy);

    const loading = fetchBundleAsset(BASE, "voices.bin");
    // Take the rejection at once: it arrives while the timers are being run.
    const settled = loading.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    const failure = await settled;

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /Failed to download voices\.bin after 4 tries: Failed to fetch\. Files already downloaded are kept/,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("does not ask again for a file the server refuses", async () => {
    vi.stubGlobal("caches", undefined);
    const fetchSpy = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchBundleAsset(BASE, "missing.onnx")).rejects.toThrow(
      "Failed to fetch missing.onnx: HTTP 404",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
