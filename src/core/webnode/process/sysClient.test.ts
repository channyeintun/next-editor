// @vitest-environment node
// The process side of the kernel link, fed kernel messages by hand: the
// per-fd backlog that keeps what a terminal sent a stopped reader, saying a
// chunk reached its reader, giving a pipe back what reached a stopped one,
// writes handed over within a pipe's worth and the bytes they carry, child
// exits that arrive before anyone asks, and nextTick draining after a message.
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessInit, ProcessMessage } from "../protocol";
import {
  INITIAL_SYNC_BUFFER_BYTES,
  SYNC_BROKEN,
  SYNC_HEADER_BYTES,
  serializeError,
} from "../protocol";
import { createSystemError, toSystemErrorRecord } from "../errors";
import { createUmaskCell, DEFAULT_UMASK, readUmask, writeUmask } from "../umask";
import { encodePayload, writeSyncAnswer } from "../kernel/codec";
import { runMacrotask } from "./node/eventLoop";
import { createProcess } from "./node/process";
import { createProcessClient } from "./sysClient";
import { THREAD_EXIT_MESSAGE } from "./node/worker_threads";
import { setRuntime } from "./runtime";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A client whose blocking calls the kernel answers at once, with `answer`'s value. */
function makeClient(
  answer: (op: string, args: unknown[]) => unknown = () => undefined,
  ttyFds: number[] = [],
  ipc: MessagePort | null = null,
  thread: ProcessInit["thread"] = null,
) {
  const sent: ProcessMessage[] = [];
  const init: ProcessInit = {
    type: "init",
    pid: 5,
    ppid: 1,
    thread,
    program: "node",
    argv: ["/bin/node"],
    execArgv: [],
    env: {},
    cwd: "/",
    umask: createUmaskCell(DEFAULT_UMASK),
    syncBuffer: new SharedArrayBuffer(INITIAL_SYNC_BUFFER_BYTES),
    sharedFs: null,
    ttyFds,
    inheritedFds: [],
    terminal: { cols: 80, rows: 24 },
    ipc,
  };
  let failure: Error | null = null;
  const client = createProcessClient(
    {
      postMessage: (message) => {
        sent.push(message);
        if (message.type === "sync") {
          // The kernel answers a blocking call in the shared buffer at once.
          const error = failure;
          failure = null;
          writeSyncAnswer(
            init.syncBuffer,
            error === null,
            encodePayload(
              error === null
                ? answer(message.op, message.args)
                : serializeError(error, toSystemErrorRecord(error)),
            ),
          );
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
  /** Fails the next blocking call with `error`. */
  const failNext = (error: Error) => {
    failure = error;
  };
  return { client, sent, posts, init, failNext };
}

const data = (fd: number, text: string | null) =>
  ({ type: "fd-data", fd, chunk: text === null ? null : encoder.encode(text) }) as const;

afterEach(() => {
  setRuntime(null);
});

describe("the file mode creation mask", () => {
  it("is the word the kernel gave the process: read there, set there, never asked for", () => {
    const { client, init, sent } = makeClient();
    expect(client.runtime.umask).toBe(0o022);
    client.runtime.umask = 0o077;
    expect(readUmask(init.umask)).toBe(0o077);
    // What the kernel, or another thread of the process, sets is this one's too.
    writeUmask(init.umask, 0o027);
    expect(client.runtime.umask).toBe(0o027);
    // Only the permission bits are kept, as umask(2) keeps them.
    client.runtime.umask = 0o7002;
    expect(client.runtime.umask).toBe(0o002);
    expect(sent).toEqual([]);
  });

  it("passes the mask a spawn names on to the kernel, and none when it names none", () => {
    const { client, sent } = makeClient((op) =>
      op === "proc.spawn" ? { pid: 9, stdio: [null, null, null] } : undefined,
    );
    const request = { command: "node", args: [], cwd: "/", env: {}, stdio: [] };
    client.runtime.processes.spawn({ ...request, umask: 0o077 });
    client.runtime.processes.spawn(request);
    const masks = sent.flatMap((message) =>
      message.type === "sync" && message.op === "proc.spawn"
        ? [(message.args[0] as { umask?: number }).umask]
        : [],
    );
    expect(masks).toEqual([0o077, undefined]);
  });
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
    // The fd is closed already: the request only marks the point, and
    // closes nothing (another thread may hold the number by now).
    const marker = sent.find(
      (message): message is Extract<ProcessMessage, { type: "call" }> => message.type === "call",
    );
    expect([marker?.op, marker?.args]).toEqual(["mark", []]);
    client.receive({ type: "reply", id: marker!.id, ok: true, value: undefined });
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

describe("pipe acknowledgements", () => {
  const counted = (fd: number, length: number) =>
    ({ type: "fd-data", fd, chunk: new Uint8Array(length), counted: true }) as const;
  const acks = (sent: ProcessMessage[]) =>
    sent
      .filter(
        (message): message is Extract<ProcessMessage, { type: "post" }> =>
          message.type === "post" && message.op === "fd.ack",
      )
      .map((message) => message.args);
  const unreads = (sent: ProcessMessage[]) =>
    sent.filter(
      (message): message is Extract<ProcessMessage, { type: "call" }> =>
        message.type === "call" && message.op === "fd.unread",
    );

  it("says each pipe chunk reached its reader as it hands it over, before the reader runs", () => {
    const { client, sent } = makeClient();
    const seen: unknown[][][] = [];
    client.runtime.fdStream.readStart(3, () => seen.push(acks(sent)));
    client.runtime.fdStream.readStart(4, () => {});
    client.receive(counted(3, 100));
    client.receive(counted(4, 50));
    // A terminal's bytes are not counted.
    client.receive(data(3, "tty"));
    expect(seen[0]).toEqual([[3, 100]]);
    expect(acks(sent)).toEqual([
      [3, 100],
      [4, 50],
    ]);
  });

  it("takes nothing while its reader is stopped: what arrives then goes back to the pipe", () => {
    const { client, sent, posts } = makeClient();
    const got: number[] = [];
    client.runtime.fdStream.readStart(3, (chunk) => got.push(chunk!.byteLength));
    client.receive(counted(3, 100));
    client.runtime.fdStream.readStop(3);
    // On their way when the kernel learned of the stop.
    client.receive(counted(3, 1000));
    client.receive(counted(3, 2000));
    client.receive(data(3, null));
    // Not acknowledged, which would free their room in the pipe: given back,
    // once, and everything that arrives until the kernel answers went back with it.
    expect(acks(sent)).toEqual([[3, 100]]);
    const requests = unreads(sent);
    expect(requests.map((request) => request.args)).toEqual([[3, []]]);
    // A reader that starts meanwhile gets none of it from here…
    client.runtime.fdStream.readStart(3, (chunk) => got.push(chunk!.byteLength));
    client.receive(counted(3, 3000));
    expect(got).toEqual([100]);
    // …the kernel sends it again, after its answer, for the stream asked for after the request.
    expect(sent.indexOf(requests[0])).toBeLessThan(sent.indexOf(posts("fd.readStart").at(-1)!));
    client.receive({ type: "reply", id: requests[0].id, ok: true, value: undefined });
    client.receive(counted(3, 1000));
    expect(got).toEqual([100, 1000]);
    expect(acks(sent)).toEqual([
      [3, 100],
      [3, 1000],
    ]);
    expect(unreads(sent)).toHaveLength(1);
  });

  it("keeps the end of a pipe for the next reader when nothing went back before it", () => {
    const { client, sent, posts } = makeClient();
    const got: (number | null)[] = [];
    client.runtime.fdStream.readStart(3, () => {});
    client.runtime.fdStream.readStop(3);
    client.receive(data(3, null));
    client.runtime.fdStream.readStart(3, (chunk) => got.push(chunk && chunk.byteLength));
    expect(got).toEqual([null]);
    expect(unreads(sent)).toEqual([]);
    // The kernel's stream had ended: it is not asked for another.
    expect(posts("fd.readStart")).toHaveLength(1);
  });

  it("hands a chunk that arrives after the reader started again to that reader", () => {
    // A stream that pauses and resumes at once (a full buffer, read in the
    // same turn): the chunk on its way is not sent twice.
    const { client, sent } = makeClient();
    const got: number[] = [];
    const reader = (chunk: Uint8Array | null) => got.push(chunk!.byteLength);
    client.runtime.fdStream.readStart(3, reader);
    client.receive(counted(3, 100));
    client.runtime.fdStream.readStop(3);
    client.runtime.fdStream.readStart(3, reader);
    client.receive(counted(3, 200));
    expect(got).toEqual([100, 200]);
    expect(unreads(sent)).toEqual([]);
    expect(acks(sent)).toEqual([
      [3, 100],
      [3, 200],
    ]);
  });

  it("says nothing for what arrives after it closed the fd: the kernel put that back", () => {
    const { client, sent } = makeClient();
    client.runtime.fdStream.readStart(3, () => {});
    client.runtime.fdStream.close(3);
    client.receive(counted(3, 1000));
    expect(acks(sent)).toEqual([]);
  });
});

describe("terminal acknowledgements", () => {
  const typed = (fd: number, text: string) =>
    ({ type: "fd-data", fd, chunk: encoder.encode(text), typed: true }) as const;
  const acks = (sent: ProcessMessage[]) =>
    sent
      .filter(
        (message): message is Extract<ProcessMessage, { type: "post" }> =>
          message.type === "post" && message.op === "fd.ack",
      )
      .map((message) => message.args);

  it("says a terminal's chunk reached its reader as it hands it over, before the reader runs", () => {
    const { client, sent } = makeClient();
    const seen: unknown[][][] = [];
    client.runtime.fdStream.readStart(0, () => seen.push(acks(sent)));
    client.receive(typed(0, "one\n"));
    // Said first: the reader may end the process, and the line was its own.
    expect(seen).toEqual([[[0, 4]]]);
  });

  it("says nothing for what reaches a stopped reader until a reader takes it", () => {
    const { client, sent, posts } = makeClient();
    const got: string[] = [];
    client.runtime.fdStream.readStart(0, () => {});
    client.runtime.fdStream.readStop(0);
    client.receive(typed(0, "two\n"));
    client.receive(typed(0, "three\n"));
    // Still the terminal's: the kernel gives them back if this process ends now.
    expect(acks(sent)).toEqual([]);
    client.runtime.fdStream.readStart(0, (chunk) => {
      got.push(decoder.decode(chunk!));
      // The reader stops again after one line: the other stays unsaid.
      client.runtime.fdStream.readStop(0);
    });
    expect(got).toEqual(["two\n"]);
    expect(acks(sent)).toEqual([[0, 4]]);
    client.runtime.fdStream.readStart(0, (chunk) => got.push(decoder.decode(chunk!)));
    expect(got).toEqual(["two\n", "three\n"]);
    expect(acks(sent)).toEqual([
      [0, 4],
      [0, 6],
    ]);
    // The acknowledgements go before the request that restarts the kernel's stream.
    expect(sent.indexOf(posts("fd.ack").at(-1)!)).toBeLessThan(
      sent.indexOf(posts("fd.readStart").at(-1)!),
    );
    // From here on a chunk is handed over as it arrives.
    client.receive(typed(0, "four\n"));
    expect(acks(sent)).toHaveLength(3);
  });

  it("says nothing for what arrives after it closed the fd: the kernel gave that back", () => {
    const { client, sent } = makeClient();
    client.runtime.fdStream.readStart(0, () => {});
    client.runtime.fdStream.close(0);
    client.receive(typed(0, "late\n"));
    expect(acks(sent)).toEqual([]);
  });
});

describe("giving a pipe back what was not used (fd.unread)", () => {
  const calls = (sent: ProcessMessage[], op: string) =>
    sent.filter(
      (message): message is Extract<ProcessMessage, { type: "call" }> =>
        message.type === "call" && message.op === op,
    );

  it("gives back the reader's bytes, and drops what was on its way: the kernel puts that back", () => {
    const { client, sent } = makeClient();
    const got: (string | null)[] = [];
    const piped = (text: string) => ({ ...data(3, text), counted: true }) as const;
    client.runtime.fdStream.readStart(3, (chunk) => {
      got.push(chunk && decoder.decode(chunk));
      client.runtime.fdStream.readStop(3);
    });
    client.receive(piped("ab"));
    // The reader used "a". The end reached it while it was stopped.
    client.receive(data(3, null));
    client.runtime.fdStream.unread(3, encoder.encode("b"));
    const [request] = calls(sent, "fd.unread");
    expect(request.args[0]).toBe(3);
    expect((request.args[1] as Uint8Array[]).map((chunk) => decoder.decode(chunk))).toEqual(["b"]);
    // Sent before the kernel took the request: it put that back in the pipe itself.
    client.receive(piped("c"));
    expect(calls(sent, "fd.unread")).toHaveLength(1);
    client.receive({ type: "reply", id: request.id, ok: true, value: undefined });
    // The next reader asks the kernel again: the end that waited here came
    // before the bytes given back, so it is not the end any more.
    client.runtime.fdStream.readStart(3, (chunk) => got.push(chunk && decoder.decode(chunk)));
    expect(got).toEqual(["ab"]);
    client.receive(piped("bc"));
    client.receive(data(3, null));
    expect(got).toEqual(["ab", "bc", null]);
    expect(
      sent.filter((message) => message.type === "post" && message.op === "fd.ack"),
    ).toHaveLength(2);
  });

  it("gives back what a stopped reader was sent even when the reader kept nothing", () => {
    const { client, sent } = makeClient();
    client.runtime.fdStream.readStart(3, () => {});
    client.runtime.fdStream.readStop(3);
    client.runtime.fdStream.unread(3, new Uint8Array(0));
    expect(calls(sent, "fd.unread").map((request) => request.args)).toEqual([[3, []]]);
  });

  it("asks nothing for an fd it never read", () => {
    const { client, sent } = makeClient();
    client.runtime.fdStream.unread(4, new Uint8Array(0));
    expect(calls(sent, "fd.unread")).toEqual([]);
  });

  it("keeps no place for the data of an fd it gave bytes back to without reading it as a stream", () => {
    const { client, sent } = makeClient();
    // Read with fs.readAsync, as the shell reads: never a stream here.
    client.runtime.fdStream.unread(4, encoder.encode("b"));
    const [request] = calls(sent, "fd.unread");
    client.receive({ type: "reply", id: request.id, ok: true, value: undefined });
    client.runtime.fs.close(4);
    // Nothing waits under that number for whoever has it next.
    client.receive(data(4, "not for this reader"));
    const got: (string | null)[] = [];
    client.runtime.fdStream.readStart(4, (chunk) => got.push(chunk && decoder.decode(chunk)));
    expect(got).toEqual([]);
  });
});

describe("a read the caller can give up (readAsync with a signal)", () => {
  const reads = (sent: ProcessMessage[]) =>
    sent.filter(
      (message): message is Extract<ProcessMessage, { type: "call" }> =>
        message.type === "call" && message.op === "fs.read",
    );
  const interrupted = () => serializeError(new Error("EINTR"), { code: "EINTR", syscall: "read" });

  it("names the read to the kernel and asks it to withdraw that read on abort", async () => {
    const { client, sent, posts } = makeClient();
    const first = new AbortController();
    const second = new AbortController();
    const one = client.runtime.fs.readAsync(0, 100, null, first.signal);
    const two = client.runtime.fs.readAsync(0, 100, null, second.signal);
    const [firstCall, secondCall] = reads(sent);
    const [firstToken, secondToken] = [firstCall.args[3], secondCall.args[3]];
    expect(typeof firstToken).toBe("number");
    expect(secondToken).not.toBe(firstToken);
    expect(posts("fs.readCancel")).toEqual([]);
    second.abort();
    expect(posts("fs.readCancel").map((post) => post.args)).toEqual([[secondToken]]);
    // The kernel decides how each read ends: withdrawn, or answered with bytes.
    client.receive({ type: "reply", id: secondCall.id, ok: false, error: interrupted() });
    client.receive({ type: "reply", id: firstCall.id, ok: true, value: encoder.encode("hi") });
    await expect(two).rejects.toMatchObject({ code: "EINTR", syscall: "read" });
    expect(decoder.decode(await one)).toBe("hi");
    // An answered read is not given up any more.
    first.abort();
    expect(posts("fs.readCancel")).toHaveLength(1);
  });

  it("asks at once for a read whose signal has aborted already", () => {
    const { client, sent, posts } = makeClient();
    const given = new AbortController();
    given.abort();
    void client.runtime.fs.readAsync(0, 100, null, given.signal).catch(() => {});
    expect(posts("fs.readCancel").map((post) => post.args)).toEqual([[reads(sent)[0].args[3]]]);
  });

  it("names nothing for a read without a signal", () => {
    const { client, sent } = makeClient();
    void client.runtime.fs.readAsync(0, 100, null);
    expect(reads(sent)[0].args).toEqual([0, 100, null]);
  });
});

describe("ending as a signal would (die)", () => {
  it("asks the kernel with a post, in order after the writes before it", () => {
    const { client, sent } = makeClient();
    client.runtime.fdStream.write(1, encoder.encode("bye"), () => {});
    client.runtime.processes.die("SIGINT");
    const ops = sent.flatMap((message) =>
      message.type === "post" || message.type === "call" || message.type === "sync"
        ? [message.op]
        : [],
    );
    expect(ops.slice(-2)).toEqual(["fd.write", "proc.die"]);
  });
});

describe("fd writes", () => {
  const ops = (sent: ProcessMessage[]) =>
    sent.map((message) => ("op" in message ? `${message.type} ${message.op}` : message.type));
  const written = (op: string, args: unknown[]) =>
    op === "fs.write" ? (args[1] as Uint8Array).byteLength : undefined;
  const brokenPipe = () => Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });
  /** Raises the kernel's count of broken pipes in the worker's sync buffer. */
  const breakPipe = (client: ReturnType<typeof makeClient>) => {
    const header = new Int32Array(client.init.syncBuffer, 0, SYNC_HEADER_BYTES / 4);
    Atomics.add(header, SYNC_BROKEN, 1);
  };

  it("asks the kernel on an fd's first write, then hands writes over without waiting", () => {
    const { client, sent } = makeClient(written);
    client.runtime.fdStream.write(5, new Uint8Array(10));
    client.runtime.fdStream.write(5, new Uint8Array(10));
    client.runtime.fdStream.write(5, new Uint8Array(10));
    expect(ops(sent)).toEqual(["sync fs.write", "post fd.write", "post fd.write"]);
  });

  it("waits for the kernel once a pipe's worth is handed over and not known to be in", () => {
    const { client, sent } = makeClient(written);
    const write = (length: number) => client.runtime.fdStream.write(5, new Uint8Array(length));
    write(1);
    write(40_000);
    write(25_536);
    // 65536 handed over since the kernel last said everything was in: the next one waits.
    write(1);
    write(1);
    expect(ops(sent)).toEqual([
      "sync fs.write",
      "post fd.write",
      "post fd.write",
      "sync fs.write",
      "post fd.write",
    ]);
  });

  it("waits for the kernel after 256 writes handed over, however small", () => {
    const { client, sent } = makeClient(written);
    for (let index = 0; index < 1 + 256 + 1 + 1; index += 1) {
      client.runtime.fdStream.write(5, new Uint8Array(1));
    }
    const kinds = ops(sent);
    expect(kinds.filter((kind) => kind === "post fd.write")).toHaveLength(257);
    expect([kinds[0], kinds[257], kinds[258]]).toEqual([
      "sync fs.write",
      "sync fs.write",
      "post fd.write",
    ]);
  });

  it("runs `done` at once for a write handed over, and on the kernel's answer past that", async () => {
    const { client, sent } = makeClient();
    const done: (Error | null)[] = [];
    const write = (length: number) =>
      client.runtime.fdStream.write(5, new Uint8Array(length), (error) => done.push(error));
    write(10);
    // The first write asks: `done` waits for the answer.
    expect(done).toEqual([]);
    const first = sent.at(-1) as Extract<ProcessMessage, { type: "call" }>;
    expect([first.type, first.op]).toEqual(["call", "fd.write"]);
    client.receive({ type: "reply", id: first.id, ok: true, value: 10 });
    await Promise.resolve();
    expect(done).toEqual([null]);
    write(65_536);
    expect(done).toEqual([null, null]);
    write(1);
    expect(done).toEqual([null, null]);
    expect(ops(sent).slice(-2)).toEqual(["post fd.write", "call fd.write"]);
  });

  it("asks again after a pipe it writes to lost its reader, and fails with EPIPE", async () => {
    const harness = makeClient(written);
    const { client, sent } = harness;
    client.runtime.fdStream.write(5, new Uint8Array(10));
    client.runtime.fdStream.write(5, new Uint8Array(10));
    expect(ops(sent)).toEqual(["sync fs.write", "post fd.write"]);
    breakPipe(harness);
    harness.failNext(brokenPipe());
    expect(() => client.runtime.fdStream.write(5, new Uint8Array(10))).toThrow(/EPIPE/);
    expect(ops(sent).at(-1)).toBe("sync fs.write");
    // A write with `done` hears it from the kernel's answer instead.
    const done: (Error | null)[] = [];
    client.runtime.fdStream.write(5, new Uint8Array(10), (error) => done.push(error));
    const call = sent.at(-1) as Extract<ProcessMessage, { type: "call" }>;
    expect([call.type, call.op]).toEqual(["call", "fd.write"]);
    client.receive({
      type: "reply",
      id: call.id,
      ok: false,
      error: { name: "Error", message: "EPIPE", code: "EPIPE" },
    });
    await Promise.resolve();
    expect(done.map((error) => (error as { code?: string } | null)?.code)).toEqual(["EPIPE"]);
  });

  it("fails a write to a broken pipe with the system call's error, whichever way it waited", async () => {
    // What a stream needs to name the failure as Node does (`write EPIPE`):
    // the code, the errno and the system call.
    const harness = makeClient(written);
    const { client, sent } = harness;
    const refused = createSystemError("EPIPE", "write");
    harness.failNext(refused);
    let thrown: unknown;
    try {
      client.runtime.fdStream.write(5, new Uint8Array(10));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "EPIPE", errno: -32, syscall: "write" });
    const given: (Error | null)[] = [];
    client.runtime.fdStream.write(5, new Uint8Array(10), (error) => given.push(error));
    const call = sent.at(-1) as Extract<ProcessMessage, { type: "call" }>;
    client.receive({
      type: "reply",
      id: call.id,
      ok: false,
      error: serializeError(refused, toSystemErrorRecord(refused)),
    });
    await Promise.resolve();
    expect(given).toHaveLength(1);
    expect(given[0]).toMatchObject({ code: "EPIPE", errno: -32, syscall: "write" });
  });

  it("forgets what it knew of a closed fd", () => {
    const { client, sent } = makeClient(written);
    client.runtime.fdStream.write(5, new Uint8Array(10));
    client.runtime.fs.close(5);
    client.runtime.fdStream.write(5, new Uint8Array(10));
    expect(ops(sent)).toEqual(["sync fs.write", "sync fs.close", "sync fs.write"]);
  });

  it("forgets it for a stream closed as a stream, too: the number's next stream is asked first", () => {
    const { client, sent } = makeClient(written);
    // A child's stdin: written to, then closed with the stream's own close.
    client.runtime.fdStream.write(5, new Uint8Array(10));
    client.runtime.fdStream.write(5, new Uint8Array(10));
    client.runtime.fdStream.close(5);
    // The next child's stdin gets the number: nothing is known of its pipe.
    client.runtime.fdStream.write(5, new Uint8Array(10));
    expect(ops(sent)).toEqual(["sync fs.write", "post fd.write", "call fd.close", "sync fs.write"]);
  });

  it("learns nothing from an empty write: the write after it still asks", () => {
    const harness = makeClient(written);
    const { client, sent } = harness;
    // write(2) of no bytes succeeds whatever the pipe's state, and asks nothing.
    client.runtime.fdStream.write(5, new Uint8Array(0));
    const done: (Error | null)[] = [];
    client.runtime.fdStream.write(5, new Uint8Array(0), (error) => done.push(error));
    expect(done).toEqual([null]);
    expect(sent).toEqual([]);
    // The fd's first real write asks, and hears of the reader that went.
    harness.failNext(brokenPipe());
    expect(() => client.runtime.fdStream.write(5, new Uint8Array(1))).toThrow(/EPIPE/);
    // So does the first after a break, an empty write in between or not.
    client.runtime.fdStream.write(6, new Uint8Array(10));
    client.runtime.fdStream.write(6, new Uint8Array(10));
    breakPipe(harness);
    client.runtime.fdStream.write(6, new Uint8Array(0));
    harness.failNext(brokenPipe());
    expect(() => client.runtime.fdStream.write(6, new Uint8Array(10))).toThrow(/EPIPE/);
    expect(ops(sent)).toEqual(["sync fs.write", "sync fs.write", "post fd.write", "sync fs.write"]);
  });
});

describe("the bytes a write carries", () => {
  /** The byte arrays in the messages sent so far, by operation. */
  const carried = (sent: ProcessMessage[], op: string) =>
    sent.flatMap((message) =>
      "op" in message && message.op === op
        ? message.args.filter((value): value is Uint8Array => value instanceof Uint8Array)
        : [],
    );
  const written = (op: string, args: unknown[]) =>
    op === "fs.write" ? (args[1] as Uint8Array).byteLength : undefined;

  it("sends a view of part of a buffer as its own bytes, never the buffer around it", () => {
    const { client, sent } = makeClient(written);
    // What a zlib stream or `buffer.subarray()` hands a stream: a Buffer over
    // part of a much larger one, whose own `slice` is another view.
    const large = Buffer.alloc(1 << 20, 0x61);
    large.write("line", 500_000);
    const view = large.subarray(500_000, 500_004);
    client.runtime.fdStream.write(5, view);
    client.runtime.fdStream.write(5, view);
    client.runtime.fdStream.write(5, view, () => {});
    client.runtime.fs.write(7, view, null);
    client.runtime.fs.writeFile("/dev/stdout", view, 0, 0o644);
    client.runtime.tty.unread(0, view);
    client.runtime.fdStream.readStart(8, () => {});
    client.runtime.fdStream.unread(8, view);
    const all = ["fs.write", "fd.write", "fs.writeFile", "tty.unread", "fd.unread"].flatMap((op) =>
      carried(sent, op),
    );
    const unreadChunks = sent.flatMap((message) =>
      "op" in message && message.op === "fd.unread" ? (message.args[1] as Uint8Array[]) : [],
    );
    expect(all.length + unreadChunks.length).toBe(7);
    for (const bytes of [...all, ...unreadChunks]) {
      expect(decoder.decode(bytes)).toBe("line");
      expect(bytes.buffer.byteLength).toBe(4);
    }
  });

  it("sends shared memory as a copy: the kernel reads it after the program wrote there again", () => {
    const { client, sent } = makeClient(written);
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    shared.set(encoder.encode("one\n"));
    client.runtime.fdStream.write(5, shared);
    client.runtime.fdStream.write(5, shared);
    client.runtime.fs.write(7, shared, null);
    shared.set(encoder.encode("two\n"));
    const all = [...carried(sent, "fs.write"), ...carried(sent, "fd.write")];
    expect(all).toHaveLength(3);
    for (const bytes of all) {
      expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
      expect(decoder.decode(bytes)).toBe("one\n");
    }
  });

  it("sends a whole buffer as it is", () => {
    const { client, sent } = makeClient(written);
    const whole = new Uint8Array(1000);
    client.runtime.fdStream.write(5, whole);
    client.runtime.fs.write(7, whole, null);
    expect(carried(sent, "fs.write").map((bytes) => bytes.buffer === whole.buffer)).toEqual([
      true,
      true,
    ]);
  });
});

describe("a blocking write's error", () => {
  const brokenPipe = () => Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });

  it("reaches process.stdout after what the kernel sent first: a SIGINT before the EPIPE", async () => {
    // `node w.js | while read l; do sleep 1; done`, then Ctrl+C: the kernel
    // sends the writer its SIGINT, the reader goes, and the write that was
    // waiting for room fails. Node (macOS) runs the SIGINT handler first.
    const harness = makeClient((op, args) =>
      op === "fd.kind"
        ? "pipe"
        : op === "fs.write"
          ? (args[1] as Uint8Array).byteLength
          : undefined,
    );
    const { client, sent } = harness;
    setRuntime(client.runtime);
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: string[] = [];
    process.on("SIGINT", () => order.push("SIGINT"));
    process.stdout.on("error", (error: { code?: string }) => order.push(`error ${error.code}`));
    const before = sent.length;
    harness.failNext(brokenPipe());
    runMacrotask(() => process.stdout.write("x".repeat(1000)));
    // The error waits for the kernel's answer to a call made after the write failed.
    const call = sent
      .slice(before)
      .find(
        (message): message is Extract<ProcessMessage, { type: "call" }> => message.type === "call",
      );
    expect(call).toBeDefined();
    client.receive({ type: "signal", signal: "SIGINT" });
    client.receive({ type: "reply", id: call!.id, ok: true, value: "pipe" });
    for (let i = 0; i < 10 && order.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(order).toEqual(["SIGINT", "error EPIPE"]);
  });

  it("keeps the process alive until it is reported", () => {
    // A process with nothing else to do must not exit 0 with the error still
    // on its way: the report is what it has left to run.
    const { client, sent } = makeClient();
    const idle: number[] = [];
    client.onIdle(() => idle.push(client.refCount()));
    const reported: Error[] = [];
    const error = brokenPipe();
    client.runtime.fdStream.reportWriteError(1, error, (given) => {
      // Still held while the error is handled: an 'error' listener may start work.
      expect(client.refCount()).toBe(1);
      reported.push(given);
    });
    expect(client.refCount()).toBe(1);
    expect(idle).toEqual([]);
    const call = sent.find(
      (message): message is Extract<ProcessMessage, { type: "call" }> => message.type === "call",
    );
    client.receive({ type: "reply", id: call!.id, ok: true, value: "pipe" });
    expect(reported).toEqual([error]);
    expect(client.refCount()).toBe(0);
    expect(idle).toEqual([0]);
  });

  it("lets the process go when the report itself throws", () => {
    const { client, sent } = makeClient();
    client.runtime.fdStream.reportWriteError(1, brokenPipe(), () => {
      throw new Error("an 'error' listener threw");
    });
    const call = sent.find(
      (message): message is Extract<ProcessMessage, { type: "call" }> => message.type === "call",
    );
    expect(() =>
      client.receive({
        type: "reply",
        id: call!.id,
        ok: false,
        error: { name: "Error", message: "EBADF" },
      }),
    ).toThrow(/listener threw/);
    expect(client.refCount()).toBe(0);
  });
});

describe("exit", () => {
  // The parent emits 'exit' only once this has arrived, after every message
  // the process sent on the channel before (child_process.test.ts).
  it("says so last on the process's IPC channel, before the kernel is asked to end it", () => {
    const order: string[] = [];
    const ipc = {
      postMessage: (message: unknown) => order.push(`ipc ${JSON.stringify(message)}`),
    } as unknown as MessagePort;
    const { client } = makeClient(
      (op) => {
        order.push(op);
      },
      [],
      ipc,
    );
    // The kernel stops the worker instead of answering; here it answers.
    expect(() => client.runtime.processes.exit(3)).toThrow(/did not exit/);
    expect(order).toEqual(['ipc {"type":"exit"}', "proc.exit"]);
  });

  it("says so last on a thread's port, whatever the program made of postMessage", async () => {
    const { port1, port2 } = new MessageChannel();
    const received: unknown[] = [];
    port2.onmessage = (event) => received.push(event.data);
    const original = MessagePort.prototype.postMessage;
    // A test's spy that does not call through.
    MessagePort.prototype.postMessage = function () {};
    try {
      const { client } = makeClient(() => undefined, [], null, {
        threadId: 2,
        filename: "/w.js",
        eval: false,
        workerData: null,
        port: port1,
        name: "",
      });
      expect(() => client.runtime.processes.exit(0)).toThrow(/did not exit/);
    } finally {
      MessagePort.prototype.postMessage = original;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toEqual([{ type: THREAD_EXIT_MESSAGE }]);
    port1.close();
    port2.close();
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
    // In a task of its own, as the exit's message would have been.
    await Promise.resolve();
    expect(first).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
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
