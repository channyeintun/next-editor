// @vitest-environment node
// The process side of the kernel link, fed kernel messages by hand: the
// per-fd backlog that keeps bytes a stopped reader was already sent, child
// exits that arrive before anyone asks, and nextTick draining after a message.
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessInit, ProcessMessage } from "../protocol";
import { INITIAL_SYNC_BUFFER_BYTES } from "../protocol";
import { encodePayload, writeSyncAnswer } from "../kernel/codec";
import { createProcess } from "./node/process";
import { createProcessClient } from "./sysClient";
import { setRuntime } from "./runtime";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function makeClient() {
  const sent: ProcessMessage[] = [];
  const init: ProcessInit = {
    type: "init",
    pid: 5,
    ppid: 1,
    thread: null,
    program: "node",
    argv: ["/bin/node"],
    execArgv: [],
    env: {},
    cwd: "/",
    syncBuffer: new SharedArrayBuffer(INITIAL_SYNC_BUFFER_BYTES),
    sharedFs: null,
    ttyFds: [],
    terminal: { cols: 80, rows: 24 },
    ipc: null,
  };
  const client = createProcessClient(
    {
      postMessage: (message) => {
        sent.push(message);
        if (message.type === "sync") {
          // The kernel answers a blocking call in the shared buffer at once.
          writeSyncAnswer(init.syncBuffer, true, encodePayload(undefined));
        }
      },
    },
    init,
  );
  const posts = (op: string) =>
    sent.filter(
      (message): message is Extract<ProcessMessage, { type: "post" }> =>
        message.type === "post" && message.op === op,
    );
  return { client, sent, posts };
}

const data = (fd: number, text: string | null) =>
  ({ type: "fd-data", fd, chunk: text === null ? null : encoder.encode(text) }) as const;

afterEach(() => {
  setRuntime(null);
});

describe("fd reading", () => {
  it("replays chunks that arrived after readStop on the next readStart, in order", () => {
    const { client, posts } = makeClient();
    const got: (string | null)[] = [];
    const reader = (chunk: Uint8Array | null) => got.push(chunk && decoder.decode(chunk));
    client.runtime.fdStream.readStart(3, reader);
    client.receive(data(3, "a"));
    client.runtime.fdStream.readStop(3);
    // Already on the way when the kernel learned of the stop.
    client.receive(data(3, "b"));
    client.receive(data(3, "c"));
    expect(got).toEqual(["a"]);
    client.runtime.fdStream.readStart(3, reader);
    expect(got).toEqual(["a", "b", "c"]);
    expect(posts("fd.readStart")).toHaveLength(2);
    client.receive(data(3, "d"));
    expect(got).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the rest queued when the reader stops again while catching up", () => {
    const { client, posts } = makeClient();
    const got: string[] = [];
    client.runtime.fdStream.readStart(3, () => {});
    client.runtime.fdStream.readStop(3);
    client.receive(data(3, "a"));
    client.receive(data(3, "b"));
    const stopping = (chunk: Uint8Array | null) => {
      got.push(decoder.decode(chunk!));
      client.runtime.fdStream.readStop(3);
    };
    client.runtime.fdStream.readStart(3, stopping);
    expect(got).toEqual(["a"]);
    // The kernel's pump is not restarted while bytes are still queued here.
    expect(posts("fd.readStart")).toHaveLength(1);
    client.receive(data(3, "c"));
    client.runtime.fdStream.readStart(3, (chunk) => got.push(decoder.decode(chunk!)));
    expect(got).toEqual(["a", "b", "c"]);
  });

  it("delivers a queued end of stream without restarting the kernel's pump", () => {
    const { client, posts } = makeClient();
    const got: (string | null)[] = [];
    client.runtime.fdStream.readStart(3, () => {});
    client.runtime.fdStream.readStop(3);
    client.receive(data(3, "z"));
    client.receive(data(3, null));
    client.runtime.fdStream.readStart(3, (chunk) => got.push(chunk && decoder.decode(chunk)));
    expect(got).toEqual(["z", null]);
    expect(posts("fd.readStart")).toHaveLength(1);
  });

  it("drops the backlog when the fd closes", () => {
    const { client } = makeClient();
    const got: string[] = [];
    client.runtime.fdStream.readStart(3, () => {});
    client.runtime.fdStream.readStop(3);
    client.receive(data(3, "stale"));
    client.runtime.fdStream.close(3);
    client.runtime.fdStream.readStart(3, (chunk) => got.push(decoder.decode(chunk!)));
    expect(got).toEqual([]);
  });

  it("ignores data for an fd nobody ever read", () => {
    const { client } = makeClient();
    expect(() => client.receive(data(9, "x"))).not.toThrow();
  });
});

describe("fd reuse", () => {
  it("drops data sent for a closed fd until the kernel answers the close", () => {
    const { client, sent } = makeClient();
    const old: string[] = [];
    const fresh: string[] = [];
    client.runtime.fdStream.readStart(3, (chunk) => old.push(decoder.decode(chunk!)));
    client.runtime.fdStream.close(3);
    // A spawn reuses fd 3 at once, and its stream starts reading.
    client.runtime.fdStream.readStart(3, (chunk) => fresh.push(decoder.decode(chunk!)));
    client.receive(data(3, "child A"));
    const close = sent.find(
      (message): message is Extract<ProcessMessage, { type: "call" }> =>
        message.type === "call" && message.op === "fd.close",
    );
    expect(close?.args).toEqual([3]);
    client.receive({ type: "reply", id: close!.id, ok: true, value: undefined });
    client.receive(data(3, "child B"));
    expect(old).toEqual([]);
    expect(fresh).toEqual(["child B"]);
  });

  it("does the same for a stream closed as a file descriptor, as the shell closes its pipes", () => {
    const { client, sent } = makeClient();
    const fresh: (string | null)[] = [];
    client.runtime.fdStream.readStart(3, () => {});
    client.runtime.fdStream.readStop(3);
    client.runtime.fs.close(3);
    // The next pipe takes fd 3 at once, and its reader starts.
    client.runtime.fdStream.readStart(3, (chunk) => fresh.push(chunk && decoder.decode(chunk)));
    // The end of the old pipe, sent before the kernel saw the close.
    client.receive(data(3, null));
    expect(fresh).toEqual([]);
    const marker = sent.find(
      (message): message is Extract<ProcessMessage, { type: "call" }> =>
        message.type === "call" && message.op === "fd.close",
    );
    expect(marker?.args).toEqual([3]);
    // The fd is closed already, so the kernel refuses: that marks the same point.
    client.receive({
      type: "reply",
      id: marker!.id,
      ok: false,
      error: { name: "Error", message: "EBADF: bad file descriptor, close", system: null },
    } as never);
    client.receive(data(3, "second pipe"));
    client.receive(data(3, null));
    expect(fresh).toEqual(["second pipe", null]);
  });

  it("asks nothing more of the kernel when a plain file is closed", () => {
    const { client, sent } = makeClient();
    client.runtime.fs.close(7);
    expect(sent.filter((message) => message.type === "call")).toEqual([]);
  });
});

describe("child exits", () => {
  it("hands an early exit to the first onExit only", async () => {
    const { client } = makeClient();
    client.receive({ type: "child-exit", pid: 7, status: { code: 0, signal: null } });
    const first: unknown[] = [];
    const second: unknown[] = [];
    client.runtime.processes.onExit(7, (status) => first.push(status));
    client.runtime.processes.onExit(7, (status) => second.push(status));
    await Promise.resolve();
    expect(first).toEqual([{ code: 0, signal: null }]);
    expect(second).toEqual([]);
  });
});

describe("nextTick", () => {
  it("runs ticks queued while handling a message before promise jobs", async () => {
    const { client } = makeClient();
    setRuntime(client.runtime);
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: string[] = [];
    client.runtime.fdStream.readStart(3, () => {
      void Promise.resolve().then(() => order.push("promise"));
      process.nextTick(() => order.push("tick"));
    });
    client.receive(data(3, "x"));
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["tick", "promise"]);
  });
});
