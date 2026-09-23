import { afterEach, describe, expect, it } from "vitest";
import { deleteRecordingOpfs, openRecordingOpfsStream } from "./recordingOpfs";
import { RECORDING_OPFS_DIRECTORY, recordingOpfsFilename } from "./recordingOpfsShared";

// jsdom has no Worker, so every test here runs the way the app does when the
// OPFS writer worker failed to start.

const notFound = () => new DOMException("No such entry", "NotFoundError");

/** An OPFS root holding one recordings directory with the given files. */
function installOpfs(files: Map<string, Uint8Array>): void {
  const directory = {
    async getFileHandle(name: string) {
      const bytes = files.get(name);
      if (!bytes) throw notFound();
      return {
        async getFile() {
          return {
            stream: () =>
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              }),
          };
        },
      };
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw notFound();
    },
  };
  const root = {
    async getDirectoryHandle(name: string) {
      if (name !== RECORDING_OPFS_DIRECTORY) throw notFound();
      return directory;
    },
  };
  setStorage({ getDirectory: async () => root });
}

function setStorage(storage: unknown): void {
  Object.defineProperty(navigator, "storage", { configurable: true, value: storage });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const bytes: number[] = [];
  for await (const chunk of stream) bytes.push(...chunk);
  return bytes;
}

afterEach(() => {
  setStorage(undefined);
});

describe("recording OPFS without the writer worker", () => {
  it("still reads a stored take", async () => {
    installOpfs(new Map([[recordingOpfsFilename("take-1"), new Uint8Array([1, 2, 3])]]));

    const stream = await openRecordingOpfsStream("take-1");

    expect(stream).not.toBeNull();
    expect(await readAll(stream!)).toEqual([1, 2, 3]);
  });

  it("reports a take that is not stored as missing", async () => {
    installOpfs(new Map());

    await expect(openRecordingOpfsStream("take-1")).resolves.toBeNull();
  });

  it("reports unreachable storage as an error, not as a missing take", async () => {
    setStorage(undefined);

    await expect(openRecordingOpfsStream("take-1")).rejects.toThrow(/unavailable/);
  });

  it("deletes a stored take", async () => {
    const files = new Map([[recordingOpfsFilename("take-1"), new Uint8Array([1])]]);
    installOpfs(files);

    await deleteRecordingOpfs("take-1");

    expect(files.size).toBe(0);
  });

  it("treats deleting from a browser without OPFS as having nothing to delete", async () => {
    setStorage(undefined);

    await expect(deleteRecordingOpfs("take-1")).resolves.toBeUndefined();
  });
});
