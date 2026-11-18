// The `wasi` builtin: WASI preview1 for WebAssembly modules, over this
// runtime's own filesystem. The system calls are @tybys/wasm-util's (the WASI
// that napi-rs uses for its `wasm32-wasi` packages in a browser); this module
// gives it webnode's `fs` and the process's stdin, stdout and stderr, which is what
// makes napi packages built for wasm32-wasi (rolldown, Tailwind's oxide) load.
import { WASI as WasmUtilWASI } from "@tybys/wasm-util";
import type { WASIOptions as WasmUtilOptions } from "@tybys/wasm-util";
import { runtime } from "../runtime";
import fs from "./fs";
import { invalidArgType, makeNodeError } from "./internalErrors";

interface WasiOptions {
  version?: string;
  args?: string[];
  env?: Record<string, string>;
  preopens?: Record<string, string>;
  returnOnExit?: boolean;
  stdin?: number;
  stdout?: number;
  stderr?: number;
}

// WASI errno values (wasi_snapshot_preview1).
const ESUCCESS = 0;
const EAGAIN = 6;
const EBADF = 8;
const EINVAL = 28;
const EIO = 29;
const EPIPE = 64;

type WasiImport = Record<string, (...args: (number | bigint)[]) => number>;

/** The iovec list at `iovs` in `memory`, as views of the memory. */
function ioVectors(memory: WebAssembly.Memory, iovs: number, count: number): Uint8Array[] {
  const view = new DataView(memory.buffer);
  const bytes = new Uint8Array(memory.buffer);
  const vectors: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const at = view.getUint32(iovs + i * 8, true);
    const length = view.getUint32(iovs + i * 8 + 4, true);
    vectors.push(bytes.subarray(at, at + length));
  }
  return vectors;
}

function errnoOf(error: unknown): number {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EAGAIN" ? EAGAIN : code === "EBADF" ? EBADF : code === "EPIPE" ? EPIPE : EIO;
}

/** `wasi.WASI`: the system interface a WebAssembly module built for WASI imports. */
export class WASI extends WasmUtilWASI {
  #memory: WebAssembly.Memory | undefined;

  constructor(options: WasiOptions = {}) {
    if (options === null || typeof options !== "object") {
      throw invalidArgType("options", "object", options);
    }
    if (options.version !== "preview1" && options.version !== "unstable") {
      throw makeNodeError(
        "ERR_INVALID_ARG_VALUE",
        `The property 'options.version' must be one of: 'unstable', 'preview1'. Received ${String(options.version)}`,
        TypeError,
      );
    }
    super({
      version: options.version,
      args: options.args,
      env: options.env,
      preopens: options.preopens,
      returnOnExit: options.returnOnExit ?? true,
      fs,
    } as WasmUtilOptions);
    this.#routeStdio([options.stdin ?? 0, options.stdout ?? 1, options.stderr ?? 2]);
  }

  /** Records the module's memory, which the stdio calls below read and write. */
  override finalizeBindings(
    instance: WebAssembly.Instance,
    options?: { memory?: WebAssembly.Memory },
  ): void {
    super.finalizeBindings(instance, options);
    this.#memory = options?.memory ?? (instance.exports.memory as WebAssembly.Memory | undefined);
  }

  /**
   * Sends fds 0, 1 and 2 to the process's own descriptors, byte for byte, as
   * Node's WASI does. wasm-util would print stdout and stderr line by line as
   * text (dropping a last line without a newline and mangling bytes that are
   * not UTF-8) and has no stdin in a worker.
   */
  #routeStdio(stdio: [number, number, number]): void {
    const imports = this.wasiImport as unknown as WasiImport;
    const fdWrite = imports.fd_write;
    const fdRead = imports.fd_read;
    imports.fd_write = (fd, iovs, iovsLength, size) => {
      const memory = this.#memory;
      if ((fd !== 1 && fd !== 2) || !memory) {
        return fdWrite(fd, iovs, iovsLength, size);
      }
      if ((Number(iovs) === 0 && iovsLength) || Number(size) === 0) {
        return EINVAL;
      }
      let written = 0;
      try {
        for (const vector of ioVectors(memory, Number(iovs), Number(iovsLength))) {
          // A copy: the module may reuse its buffer before the kernel takes it.
          runtime().fdStream.write(stdio[fd], vector.slice());
          written += vector.length;
        }
      } catch (error) {
        // As uvwasi: a reader that has gone is EPIPE for the module (Rust's
        // println! panics on it), unless some bytes went in first.
        if (written === 0) {
          return errnoOf(error);
        }
      }
      new DataView(memory.buffer).setUint32(Number(size), written, true);
      return ESUCCESS;
    };
    imports.fd_read = (fd, iovs, iovsLength, size) => {
      const memory = this.#memory;
      if (fd !== 0 || !memory) {
        return fdRead(fd, iovs, iovsLength, size);
      }
      if ((Number(iovs) === 0 && iovsLength) || Number(size) === 0) {
        return EINVAL;
      }
      let read = 0;
      try {
        for (const vector of ioVectors(memory, Number(iovs), Number(iovsLength))) {
          const count = fs.readSync(stdio[0], vector, 0, vector.length, null);
          read += count;
          if (count < vector.length) {
            break;
          }
        }
      } catch (error) {
        if (read === 0) {
          return errnoOf(error);
        }
      }
      new DataView(memory.buffer).setUint32(Number(size), read, true);
      return ESUCCESS;
    };
  }
}

const wasi = { WASI };

export default wasi;
