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
});
