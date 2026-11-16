// The `wasi` builtin: WASI preview1 for WebAssembly modules, over this
// runtime's own filesystem. The system calls are @tybys/wasm-util's (the WASI
// that napi-rs uses for its `wasm32-wasi` packages in a browser); this module
// gives it webnode's `fs` and the process's stdout and stderr, which is what
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

const encoder = new TextEncoder();

/** Writes what a module prints to one of the process's file descriptors. */
function printer(fd: number): (text: string) => void {
  return (text) => {
    runtime().fdStream.write(fd, encoder.encode(`${text}\n`));
  };
}

/** `wasi.WASI`: the system interface a WebAssembly module built for WASI imports. */
export class WASI extends WasmUtilWASI {
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
      print: printer(options.stdout ?? 1),
      printErr: printer(options.stderr ?? 2),
      fs,
    } as WasmUtilOptions);
  }
}

const wasi = { WASI };

export default wasi;
