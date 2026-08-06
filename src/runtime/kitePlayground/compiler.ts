// The Kite compiler, as WebAssembly.
//
// `src/core/kite/build/kite-compiler.wasm` is `kitec` itself built for
// `wasm32-unknown-unknown` — the same Rust the terminal runs, which is what
// makes a lesson's diagnostics the diagnostics. It is a **zero-import** module
// (see the note in `src/storage/dmpCodec/dmpCodec.ts`), so it instantiates with
// no import object and needs no glue.
//
// The boundary is a pointer and a length each way, the shape `kitec`'s own
// playground exposes:
//
//   kite_alloc(len) -> ptr        a buffer the caller writes source into
//   kite_run(ptr, len) -> ptr     compile and run; answers with what it printed
//   kite_check(ptr, len) -> ptr   diagnostics, or nothing at all
//   kite_format(ptr, len) -> ptr  the source, laid out the one way
//   kite_answer_length() -> len   how long the last answer is
//   kite_free(ptr, len)           give a buffer back
//
// Every call is synchronous once the module is instantiated, so nothing here
// needs to be async except the first load.

/** The exports this module uses. Narrower than what the module provides. */
export interface KiteCompilerExports {
  memory: WebAssembly.Memory;
  kite_alloc(length: number): number;
  kite_free(pointer: number, length: number): void;
  kite_answer_length(): number;
  kite_run(pointer: number, length: number): number;
  kite_check(pointer: number, length: number): number;
  kite_format(pointer: number, length: number): number;
}

export interface KiteCompiler {
  /** Compile and run, answering with everything the program printed. */
  run(source: string): string;
  /** Diagnostics, or the empty string when the program compiles. */
  check(source: string): string;
  /** The source, laid out the one way. */
  format(source: string): string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Call one of the string-in, string-out exports.
 *
 * The answer is copied out **before** anything else runs. A later allocation
 * can grow the module's memory, and growing it detaches every view onto the old
 * buffer — so a `Uint8Array` held across a call is a use-after-free wearing a
 * safe-looking type.
 */
function callWithSource(
  exports: KiteCompilerExports,
  entry: (pointer: number, length: number) => number,
  source: string,
): string {
  const input = encoder.encode(source);
  const at = exports.kite_alloc(input.length);
  new Uint8Array(exports.memory.buffer, at, input.length).set(input);

  const answer = entry(at, input.length);
  const length = exports.kite_answer_length();
  const bytes = new Uint8Array(exports.memory.buffer, answer, length).slice();

  exports.kite_free(answer, length);
  exports.kite_free(at, input.length);
  return decoder.decode(bytes);
}

/** Wrap instantiated exports. */
export function kiteCompilerFromExports(exports: KiteCompilerExports): KiteCompiler {
  return {
    run: (source) => callWithSource(exports, exports.kite_run, source),
    check: (source) => callWithSource(exports, exports.kite_check, source),
    format: (source) => callWithSource(exports, exports.kite_format, source),
  };
}

/**
 * Instantiate from raw module bytes. Used by tests and Node hosts, which
 * cannot import a bare `.wasm`.
 */
export async function instantiateKiteCompiler(wasmBytes: BufferSource): Promise<KiteCompiler> {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  return kiteCompilerFromExports(instance.exports as unknown as KiteCompilerExports);
}

/**
 * The compiler, loaded once and shared.
 *
 * A dynamic import so the 2 MB module code-splits out of the main bundle: a
 * lesson that never runs Kite never downloads a Kite compiler. The promise is
 * cached rather than the value, so two runs racing on first use share one
 * instantiation instead of starting two.
 */
let pending: Promise<KiteCompiler> | null = null;

export function loadKiteCompiler(): Promise<KiteCompiler> {
  if (!pending) {
    pending = import("../../core/kite/build/kite-compiler.wasm").then((wasm) =>
      kiteCompilerFromExports(
        (wasm as unknown as { default?: KiteCompilerExports } & KiteCompilerExports).default ??
          (wasm as unknown as KiteCompilerExports),
      ),
    );
  }
  return pending;
}

/** Drop the cached compiler. Tests use this; nothing else should. */
export function resetKiteCompilerForTests(): void {
  pending = null;
}
