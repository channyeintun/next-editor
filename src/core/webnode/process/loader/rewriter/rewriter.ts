// The Rust rewrite of an ES module's `import` and `export` statements
// (rewriter/crate), loaded: the same job as sucrase's `imports` transform in
// transform.ts, without sucrase's one object per token. Its work lives in the
// WebAssembly module's own memory, which goes when the worker that loaded it
// does.
import { REWRITER_WASM_BASE64 } from "./wasm.generated";

/** The rewriter leaves a module to sucrase: `message` says why. */
export class RewriteDeclined extends Error {
  constructor(why: string) {
    super(why);
    this.name = "RewriteDeclined";
  }
}

interface RewriterExports {
  memory: WebAssembly.Memory;
  wnr_alloc(length: number): number;
  wnr_rewrite(pointer: number, length: number): number;
  wnr_result_ptr(): number;
  wnr_result_len(): number;
  wnr_release(): void;
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Loads the rewriter. The function it answers with takes a module's text (as
 * transform.ts hands it to sucrase) and gives the rewritten code, or throws
 * `RewriteDeclined` for a module it leaves to sucrase.
 */
export async function loadRewriter(): Promise<(text: string) => string> {
  const { instance } = await WebAssembly.instantiate(decodeBase64(REWRITER_WASM_BASE64), {});
  const wasm = instance.exports as unknown as RewriterExports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return (text) => {
    const source = encoder.encode(text);
    const pointer = wasm.wnr_alloc(source.length);
    new Uint8Array(wasm.memory.buffer, pointer, source.length).set(source);
    let rewritten: boolean;
    try {
      rewritten = wasm.wnr_rewrite(pointer, source.length) === 1;
    } catch (error) {
      // A trap: the module is in no state to be asked again, and is not.
      throw new RewriteDeclined(`the rewriter failed: ${String(error)}`);
    }
    const result = decoder.decode(
      new Uint8Array(wasm.memory.buffer, wasm.wnr_result_ptr(), wasm.wnr_result_len()),
    );
    wasm.wnr_release();
    if (!rewritten) {
      throw new RewriteDeclined(result);
    }
    return result;
  };
}
