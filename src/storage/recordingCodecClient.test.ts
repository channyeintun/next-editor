import { expose } from "comlink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "../core/src";
import { decompressBinaryToRecording as decodeInProcess } from "./recordingCodec";
import { encodeRecordingToStream } from "./streamingRecordingCodec";

// The real worker needs the wasm diff codec, which Vitest cannot import; the
// client only awaits it, so a resolved stand-in is enough here.
vi.mock("./dmpCodec/dmpCodec", () => ({ loadDmpCodec: async () => ({}) }));

type WorkerBehavior = "decode" | "die";

/**
 * A Worker stand-in speaking comlink over a MessageChannel. It either runs the
 * real in-process decoder, as the worker module does, or dies mid-call.
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
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(4, 5, true); // a newer format

    await expect(decompressBinaryToRecording(bytes)).rejects.toThrow(
      "Unsupported SCR3 format version: 5",
    );
  });
});
