// Minimal WASI (preview1) shim for the Go codec reactor module.
//
// The Go module is built with GOOS=wasip1 and imports 16 wasi_snapshot_preview1
// functions, but it never touches the real filesystem or network — it only does
// in-memory zstd and diff. So everything except clock/random/stdout is a stub
// that reports "no such fd / not supported", which is exactly what Go's runtime
// expects when there are no preopens. This lets the same module that runs under
// node:wasi in the benchmark run unchanged in a browser worker.

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8; // bad file descriptor — "this fd doesn't exist"
const ERRNO_NOSYS = 52; // function not supported

export interface WasiShim {
  /** Import object to pass as `wasi_snapshot_preview1` during instantiation. */
  readonly wasiImport: WebAssembly.ModuleImports;
  /** Bind the instance's memory and run the reactor's `_initialize` export. */
  initialize(instance: WebAssembly.Instance): void;
}

export function createWasiShim(): WasiShim {
  let memory: WebAssembly.Memory | undefined;
  const dv = () => new DataView((memory as WebAssembly.Memory).buffer);
  const u8 = () => new Uint8Array((memory as WebAssembly.Memory).buffer);
  const decoder = new TextDecoder();

  // stdout/stderr are line-buffered to the console so a Go panic is legible.
  let stdout = "";
  let stderr = "";
  const flush = (which: "log" | "error", carry: string): string => {
    const nl = carry.lastIndexOf("\n");
    if (nl >= 0) {
      console[which](carry.slice(0, nl));
      return carry.slice(nl + 1);
    }
    return carry;
  };

  const handlers: Record<string, (...args: number[]) => number> = {
    args_sizes_get: (argcPtr, bufSizePtr) => {
      dv().setUint32(argcPtr, 0, true);
      dv().setUint32(bufSizePtr, 0, true);
      return ERRNO_SUCCESS;
    },
    args_get: () => ERRNO_SUCCESS,
    environ_sizes_get: (countPtr, bufSizePtr) => {
      dv().setUint32(countPtr, 0, true);
      dv().setUint32(bufSizePtr, 0, true);
      return ERRNO_SUCCESS;
    },
    environ_get: () => ERRNO_SUCCESS,
    clock_time_get: (_id, _precision, resultPtr) => {
      const ns = BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
      dv().setBigUint64(resultPtr, ns, true);
      return ERRNO_SUCCESS;
    },
    random_get: (ptr, len) => {
      crypto.getRandomValues(u8().subarray(ptr, ptr + len));
      return ERRNO_SUCCESS;
    },
    fd_write: (fd, iovsPtr, iovsLen, nwrittenPtr) => {
      const view = dv();
      const mem = u8();
      let written = 0;
      let text = "";
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const ptr = view.getUint32(base, true);
        const len = view.getUint32(base + 4, true);
        text += decoder.decode(mem.subarray(ptr, ptr + len));
        written += len;
      }
      if (fd === 2) stderr = flush("error", stderr + text);
      else stdout = flush("log", stdout + text);
      dv().setUint32(nwrittenPtr, written, true);
      return ERRNO_SUCCESS;
    },
    fd_read: () => ERRNO_BADF,
    fd_close: () => ERRNO_BADF,
    fd_seek: () => ERRNO_BADF,
    fd_fdstat_get: () => ERRNO_BADF,
    fd_fdstat_set_flags: () => ERRNO_BADF,
    fd_prestat_get: () => ERRNO_BADF, // no preopened directories
    fd_prestat_dir_name: () => ERRNO_BADF,
    poll_oneoff: () => ERRNO_NOSYS,
    sched_yield: () => ERRNO_SUCCESS,
    proc_exit: (code) => {
      throw new Error(`Go codec module called proc_exit(${code})`);
    },
  };

  // Any wasi import we didn't explicitly handle returns ENOSYS instead of
  // failing instantiation — defensive against future runtime additions.
  const wasiImport = new Proxy(handlers, {
    get(target, name: string) {
      return target[name] ?? (() => ERRNO_NOSYS);
    },
  }) as unknown as WebAssembly.ModuleImports;

  return {
    wasiImport,
    initialize(instance) {
      memory = instance.exports.memory as WebAssembly.Memory;
      (instance.exports._initialize as () => void)();
    },
  };
}
