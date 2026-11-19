// The entry of the worker the kernel starts to make large modules' entries
// (kernel/preparedModules.ts): a script of its own, so that no process carries
// the rewriter. This hub only wires the kernel's requests to
// loader/prepareWorker.ts.
import type { PrepareReply, PrepareRequest } from "../protocol";
import { prepareForKernel } from "./loader/prepareWorker";

interface WorkerGlobal extends EventTarget {
  postMessage(message: PrepareReply, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerGlobal;

scope.addEventListener("message", (event) => {
  const request = (event as MessageEvent<PrepareRequest>).data;
  if (request?.type !== "prepare") {
    return;
  }
  void prepareForKernel(request).then((reply) =>
    scope.postMessage(reply, reply.entry ? [reply.entry.buffer as ArrayBuffer] : []),
  );
});
