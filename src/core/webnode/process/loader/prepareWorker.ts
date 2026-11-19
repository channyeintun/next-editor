// What the worker does that the kernel starts only to make large modules'
// entries (kernel/preparedModules.ts says why the kernel has them made apart
// from every process): it rewrites the source it was handed and answers with
// the entry. It runs nothing of a project's, and touches no filesystem.
//
// It rewrites with the Rust rewriter (loader/rewriter), whose work is not
// JavaScript heap: an entry made that way can be made while a project starts,
// at no cost to the processes around it. A module the rewriter declines is
// rewritten with sucrase only where the kernel asked for that (`fallback`),
// which it does a while after the project has started.
import type { PrepareReply, PrepareRequest } from "../../protocol";
import { encodePreparedEntry } from "./preparedEntry";
import { loadRewriter } from "./rewriter/rewriter";
import { prepareSource, transformReady } from "./transform";

let rewriter: Promise<((text: string) => string) | null> | null = null;

/** The answer to `request`: the module's entry, or null where it gets none this way. */
export async function prepareForKernel(request: PrepareRequest): Promise<PrepareReply> {
  await transformReady;
  const source = new TextDecoder().decode(request.source);
  const made = (how?: (text: string) => string): PrepareReply => ({
    type: "prepared",
    entry: encodePreparedEntry(prepareSource(source, request.filename, "esm", how)),
  });
  // Loaded once: a rewriter that does not load is not tried again.
  rewriter ??= loadRewriter().catch(() => null);
  const rewrite = await rewriter;
  if (rewrite) {
    try {
      return made(rewrite);
    } catch {
      // Declined, or a source nothing rewrites.
    }
  }
  if (!request.fallback) {
    return { type: "prepared", entry: null };
  }
  try {
    return made();
  } catch {
    return { type: "prepared", entry: null };
  }
}
