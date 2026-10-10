import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { deleteCachedDialogWav, getCachedDialogWav, putCachedDialogWav } from "./dialogCache";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Cache storage backed by a Map, as much of it as dialogCache uses. */
function memoryCaches(): Pick<CacheStorage, "open"> {
  const entries = new Map<string, Response>();
  const cache = {
    match: async (url: string) => entries.get(url)?.clone(),
    put: async (url: string, response: Response) => {
      entries.set(url, response);
    },
    delete: async (url: string) => entries.delete(url),
  };
  return { open: async () => cache as unknown as Cache };
}

describe("dialogCache", () => {
  it("keeps a take and its frame-cap flag, and drops it again", async () => {
    vi.stubGlobal("caches", memoryCaches());
    const wav = new Uint8Array([82, 73, 70, 70]);

    await putCachedDialogWav("abc", { wav, hitFrameCap: true });

    expect(await getCachedDialogWav("abc")).toEqual({ wav, hitFrameCap: true });
    await deleteCachedDialogWav("abc");
    expect(await getCachedDialogWav("abc")).toBeNull();
  });

  it("keeps only a take's own bytes, from a window or a shared buffer", async () => {
    vi.stubGlobal("caches", memoryCaches());
    const take = [82, 73, 70, 70, 1, 2];
    const windowed = new Uint8Array([9, ...take, 9]).subarray(1, 1 + take.length);
    const shared = new Uint8Array(new SharedArrayBuffer(take.length));
    shared.set(take);

    await putCachedDialogWav("windowed", { wav: windowed, hitFrameCap: false });
    await putCachedDialogWav("shared", { wav: shared, hitFrameCap: false });

    expect((await getCachedDialogWav("windowed"))?.wav).toEqual(new Uint8Array(take));
    expect((await getCachedDialogWav("shared"))?.wav).toEqual(new Uint8Array(take));
  });

  it("treats a storage failure as a miss or a no-op, and reports it", async () => {
    vi.stubGlobal("caches", {
      open: async () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    const onUnavailable = vi.fn<(reason: string) => void>();

    expect(await getCachedDialogWav("abc", onUnavailable)).toBeNull();
    await expect(
      putCachedDialogWav("abc", { wav: new Uint8Array(4), hitFrameCap: false }, onUnavailable),
    ).resolves.toBeUndefined();
    await expect(deleteCachedDialogWav("abc", onUnavailable)).resolves.toBeUndefined();

    expect(onUnavailable.mock.calls).toEqual([
      ["The operation is insecure."],
      ["The operation is insecure."],
      ["The operation is insecure."],
    ]);
  });

  it("reports a write over the storage quota", async () => {
    const storage = memoryCaches();
    const cache = await storage.open("");
    cache.put = async () => {
      throw new DOMException("", "QuotaExceededError");
    };
    vi.stubGlobal("caches", storage);
    const onUnavailable = vi.fn<(reason: string) => void>();

    await putCachedDialogWav("abc", { wav: new Uint8Array(4), hitFrameCap: false }, onUnavailable);

    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith("QuotaExceededError");
  });
});
