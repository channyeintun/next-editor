// The process worker's entry: waits for the kernel's first message, connects
// this worker to the kernel, and runs the program it was started for. This hub
// only wires; each program lives under programs/.
import type { KernelMessage, ProcessInit, ProcessMessage } from "../protocol";
import { addMacrotaskListener } from "./node/eventLoop";
import { writeFd } from "./node/internal/fdWrite";
import { runNode } from "./programs/node";
import { runPackageManager } from "./programs/npm/index";
import { runShell } from "./programs/shell/index";
import { setRuntime } from "./runtime";
import { createProcessClient } from "./sysClient";
import type { ProcessClient } from "./sysClient";

interface WorkerGlobal extends EventTarget {
  postMessage(message: ProcessMessage, transfer?: Transferable[]): void;
}

// Captured before the `node` program hides the worker's own globals.
const scope = globalThis as unknown as WorkerGlobal;
const post = scope.postMessage.bind(scope);
// Not enumerable: a program that lists the global object's keys sees Node's.
Object.defineProperty(globalThis, "__webnodeNativeSetTimeout", {
  value: globalThis.setTimeout.bind(globalThis),
  configurable: true,
});

let client: ProcessClient | null = null;

/**
 * Ends a program that failed with an error instead of a status (one that
 * could not start, or that threw): the error on fd 2, whatever fd 2 is, and
 * status 1.
 */
function reportAndExit(error: unknown): void {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    // Whole, in one blocking write: a pipe takes a long report in several parts.
    writeFd(2, new TextEncoder().encode(`${text}\n`));
  } catch {
    // fd 2 is closed, or its reader has gone: nothing is left to report through.
  } finally {
    client?.runtime.processes.exit(1);
  }
}

async function run(init: ProcessInit): Promise<void> {
  client = createProcessClient({ postMessage: post }, init);
  setRuntime(client.runtime);

  if (init.program === "node") {
    await runNode(init, client);
    return;
  }
  const status =
    init.program === "shell" ? await runShell(init.argv) : await runPackageManager(init.argv);
  client.runtime.processes.exit(status);
}

// Each kernel message is a macrotask of the event loop's own kind, the worker's
// only listener of its messages: the ticks its promise jobs queue run in its
// own task, with no task of their own.
addMacrotaskListener(scope, "message", (event) => {
  const message = (event as MessageEvent<KernelMessage>).data;
  if (message.type === "init") {
    run(message).catch(reportAndExit);
    return;
  }
  client?.receive(message);
});
