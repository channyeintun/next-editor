// The process worker's entry: waits for the kernel's first message, connects
// this worker to the kernel, and runs the program it was started for. This hub
// only wires; each program lives under programs/.
import type { KernelMessage, ProcessInit, ProcessMessage } from "../protocol";
import { runNode } from "./programs/node";
import { runPackageManager } from "./programs/npm/index";
import { runShell } from "./programs/shell/index";
import { setRuntime } from "./runtime";
import { createProcessClient } from "./sysClient";
import type { ProcessClient } from "./sysClient";

interface WorkerGlobal {
  postMessage(message: ProcessMessage, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<KernelMessage>) => void): void;
}

// Captured before the `node` program hides the worker's own globals.
const scope = globalThis as unknown as WorkerGlobal;
const post = scope.postMessage.bind(scope);
(
  globalThis as unknown as { __webnodeNativeSetTimeout: typeof setTimeout }
).__webnodeNativeSetTimeout = globalThis.setTimeout.bind(globalThis);

let client: ProcessClient | null = null;

function reportAndExit(error: unknown): void {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    client?.runtime.fs.write(2, new TextEncoder().encode(`${text}\n`), null);
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

scope.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "init") {
    run(message).catch(reportAndExit);
    return;
  }
  client?.receive(message);
});
