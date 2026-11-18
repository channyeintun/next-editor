// What crosses an IPC channel between a parent and the child it forked, in
// the envelope both ends read: the child's `send` and the parent's
// (child_process.ts), `process.send` (process.ts), and the last thing a
// process says as it exits (sysClient.ts). A leaf: it imports nothing, so the
// kernel link can post an exit without loading the child_process builtin.

/**
 * A message (a `send` from either end), the sender's disconnect, or the last
 * thing a process says as it exits.
 */
export type IpcEnvelope = { type: "message"; message: unknown } | { type: "disconnect" | "exit" };

/** Posts `message` on an IPC channel in the envelope its other end reads. */
export function postIpcMessage(port: MessagePort, message: unknown): void {
  port.postMessage({ type: "message", message } satisfies IpcEnvelope);
}

/** Posts this end's disconnect: nothing more follows it on the channel. */
export function postIpcDisconnect(port: MessagePort): void {
  port.postMessage({ type: "disconnect" } satisfies IpcEnvelope);
}

/**
 * Posts the last thing a process says on its IPC channel, as it exits. Its
 * messages travel on the channel and its exit through the kernel, and nothing
 * orders the two: the parent emits 'exit' once this arrives, after every
 * message the child sent before it.
 */
export function postIpcExit(port: MessagePort): void {
  port.postMessage({ type: "exit" } satisfies IpcEnvelope);
}
