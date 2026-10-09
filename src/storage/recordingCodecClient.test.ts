import { expose } from "comlink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../core/src";
import { decompressBinaryToRecording as decodeInProcess } from "./recordingCodec";
import { encodeRecordingToStream } from "./streamingRecordingCodec";
import { STREAM_FORMAT_VERSION, UnreadableRecordingError } from "./streamingRecordingCodec/format";

// The real worker needs the wasm diff codec, which Vitest cannot import; the
// client only awaits it, so a resolved stand-in is enough here.
vi.mock("../core/dmp/dmpCodec", () => ({ loadDmpCodec: async () => ({}) }));

type WorkerBehavior = "decode" | "die" | "refuse" | "unreadable-asset";

/**
 * A Worker stand-in speaking comlink over a MessageChannel. It either runs the
 * real in-process decoder, as the worker module does, or dies mid-call. Its
 * encoder refuses the take as too large ("refuse"), or fails the way a worker
 * that cannot read a main-thread-only asset does ("unreadable-asset").
 */
function installWorker(behavior: WorkerBehavior): void {
  class FakeWorker {
    private readonly port: MessagePort;
    private readonly errorListeners: Array<() => void> = [];

    constructor() {
      const { port1, port2 } = new MessageChannel();
      expose(
        {
          decompressBinaryToRecording: (bytes: Uint8Array) => {
            if (behavior === "decode") return decodeInProcess(bytes);
            setTimeout(() => this.errorListeners.forEach((listener) => listener()), 0);
            return new Promise(() => {});
          },
          encodeRecordingToStream: () => {
            if (behavior === "refuse") {
              throw new UnreadableRecordingError("the .ne file would exceed 512 MiB");
            }
            throw new Error("Workspace asset is missing or corrupt");
          },
        },
        port2,
      );
      this.port = port1;
    }

    addEventListener(type: string, listener: EventListener) {
      if (type === "error") this.errorListeners.push(listener as () => void);
      else this.port.addEventListener(type, listener);
    }
    removeEventListener(type: string, listener: EventListener) {
      this.port.removeEventListener(type, listener);
    }
    postMessage(message: unknown, transfer: Transferable[] = []) {
      this.port.postMessage(message, transfer);
    }
    start() {
      this.port.start();
    }
    terminate() {
      this.port.close();
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
}

const recording: Recording = {
  version: 4,
  id: "take-1",
  name: "Take",
  createdAt: 1,
  duration: 10,
  keyframeInterval: 120,
  frames: [],
};

async function importClient() {
  // Fresh module state per test: the client caches its worker and its failure.
  vi.resetModules();
  return import("./recordingCodecClient");
}

beforeEach(() => {
  vi.stubGlobal("window", globalThis);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("decompressBinaryToRecording through the codec worker", () => {
  it("decodes in process, from the caller's intact bytes, when the worker dies", async () => {
    installWorker("die");
    const { decompressBinaryToRecording } = await importClient();
    const bytes = await encodeRecordingToStream(recording);
    const byteLength = bytes.byteLength;

    const decoded = await decompressBinaryToRecording(bytes);

    expect(decoded.id).toBe("take-1");
    expect(bytes.byteLength).toBe(byteLength);
  });

  it("reports the worker's own decode error instead of retrying in process", async () => {
    installWorker("decode");
    const { decompressBinaryToRecording } = await importClient();
    const bytes = await encodeRecordingToStream(recording);
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(4, STREAM_FORMAT_VERSION + 1, true); // a newer format

    await expect(decompressBinaryToRecording(bytes)).rejects.toThrow(
      `Unsupported SCR3 format version: ${STREAM_FORMAT_VERSION + 1}`,
    );
  });
});

describe("encodeRecordingToStream through the codec worker", () => {
  beforeEach(() => {
    // The client sends an encode to the worker only where IndexedDB exists.
    vi.stubGlobal("indexedDB", {});
  });

  // This take encodes fine in process, so a rejection means no in-process retry ran:
  // the refusal is deterministic, and retrying it repeated the whole encode on the
  // main thread only to fail the same way.
  it("reports the worker's too-large refusal instead of re-encoding in process", async () => {
    installWorker("refuse");
    const { encodeRecordingToStream: encodeThroughClient } = await importClient();

    await expect(encodeThroughClient(recording)).rejects.toThrow(
      "Recording is too large to save: the .ne file would exceed 512 MiB",
    );
  });

  it("re-encodes in process when the worker fails for another reason", async () => {
    installWorker("unreadable-asset");
    const { encodeRecordingToStream: encodeThroughClient } = await importClient();

    const bytes = await encodeThroughClient(recording);

    expect(Array.from(bytes)).toEqual(Array.from(await encodeRecordingToStream(recording)));
  });
});
