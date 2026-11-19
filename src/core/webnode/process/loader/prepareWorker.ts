// What a worker does that the kernel started only to make one large module's
// entry (kernel/preparedModules.ts says why the kernel has it made apart from
// every process): it rewrites the source it was handed and answers with the
// entry. It runs nothing of a project's, and touches no filesystem.
import type { PrepareReply, PrepareRequest } from "../../protocol";
import { encodePreparedEntry } from "./preparedEntry";
import { prepareSource, transformReady } from "./transform";

/** The answer to `request`: the module's entry, or null for a source that cannot be rewritten. */
export async function prepareForKernel(request: PrepareRequest): Promise<PrepareReply> {
  await transformReady;
  try {
    const source = new TextDecoder().decode(request.source);
    return {
      type: "prepared",
      entry: encodePreparedEntry(prepareSource(source, request.filename, "esm")),
    };
  } catch {
    return { type: "prepared", entry: null };
  }
}
