import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordingOpfsWorkerApi } from "./recordingOpfs.worker";
import { RECORDING_OPFS_DIRECTORY } from "./recordingOpfsShared";

const exposed = vi.hoisted(() => ({ api: null as RecordingOpfsWorkerApi | null }));

vi.mock("comlink", () => ({
  expose: (api: RecordingOpfsWorkerApi) => {
    exposed.api = api;
  },
}));

await import("./recordingOpfs.worker");

/** A browser whose file handles have no sync access handle, only createWritable. */
function installAsyncOnlyOpfs(writable: {
  write: (data: unknown) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
}): void {
  const fileHandle = { createWritable: async () => writable };
  const directory = { getFileHandle: async () => fileHandle };
  const root = {
    getDirectoryHandle: async (name: string) => {
      expect(name).toBe(RECORDING_OPFS_DIRECTORY);
      return directory;
    },
  };
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: { getDirectory: async () => root },
  });
}

afterEach(() => {
  Object.defineProperty(navigator, "storage", { configurable: true, value: undefined });
});

describe("recording OPFS worker, async writer", () => {
  it("writes and commits a replacement", async () => {
    const writable = {
      write: vi.fn<(data: unknown) => Promise<void>>().mockResolvedValue(),
      close: vi.fn<() => Promise<void>>().mockResolvedValue(),
      abort: vi.fn<() => Promise<void>>().mockResolvedValue(),
    };
    installAsyncOnlyOpfs(writable);

    await expect(exposed.api!.replace("take", new Uint8Array([1, 2, 3]))).resolves.toBe(3);

    expect(writable.write).toHaveBeenCalledTimes(1);
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(writable.abort).not.toHaveBeenCalled();
  });

  it("discards a replacement whose write fails instead of committing it", async () => {
    const quota = new DOMException("The quota has been exceeded", "QuotaExceededError");
    const writable = {
      write: vi.fn<(data: unknown) => Promise<void>>().mockRejectedValue(quota),
      close: vi.fn<() => Promise<void>>().mockRejectedValue(new TypeError("closed after error")),
      abort: vi.fn<() => Promise<void>>().mockResolvedValue(),
    };
    installAsyncOnlyOpfs(writable);

    await expect(exposed.api!.replace("take", new Uint8Array([1, 2, 3]))).rejects.toBe(quota);

    // close() would commit whatever reached the swap file over the previous contents.
    expect(writable.close).not.toHaveBeenCalled();
    expect(writable.abort).toHaveBeenCalledTimes(1);
  });
});
