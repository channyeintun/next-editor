// @vitest-environment node
// The Console against Node's own, each writing to a collecting stream.
import { Console as NodeConsole } from "node:console";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { Console, createConsole } from "./console";
import { Writable as OurWritable } from "./stream";

type Run = (c: Console) => void;

function ours(run: Run, colorMode = false): string {
  let out = "";
  const stream = { write: (s: string) => (out += s) };
  run(new Console({ stdout: stream, stderr: stream, colorMode }));
  return out;
}

function node(run: Run, colorMode = false): string {
  let out = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      out += String(chunk);
      callback();
    },
  });
  run(new NodeConsole({ stdout: stream, stderr: stream, colorMode }) as unknown as Console);
  return out;
}

describe("console.table", () => {
  const cases: [string, Run][] = [
    [
      "a Map",
      (c) =>
        c.table(
          new Map<unknown, unknown>([
            ["k", { a: 1 }],
            [{ x: 1 }, 2],
          ]),
        ),
    ],
    ["a Set", (c) => c.table(new Set([1, "two", { three: 3 }]))],
    ["an empty Map", (c) => c.table(new Map())],
    [
      "an array of objects",
      (c) =>
        c.table([
          { a: 1, b: "x" },
          { b: 2, c: [1, 2, 3, 4] },
        ]),
    ],
    ["mixed rows", (c) => c.table({ r1: 1, r2: { a: { deep: { er: 1 } } }, r3: null })],
    ["chosen columns", (c) => c.table([{ a: 1, b: 2 }, 3], ["b"])],
    ["a wide object", (c) => c.table([{ o: { a: 1, b: 2, c: 3 } }])],
    ["a primitive", (c) => c.table(5)],
    [
      "inside a group",
      (c) => {
        c.group("g");
        c.table([{ a: 1 }]);
        c.dir({ a: 1, b: { c: 2 } }, { compact: false });
        c.groupEnd();
      },
    ],
  ];
  it.each(cases)("prints %s like Node", (_label, run) => {
    expect(ours(run)).toBe(node(run));
  });

  // What a terminal shows: cells are inspected with colours, and a cell is as
  // wide as the columns it takes, not as its length in code units.
  const terminalCases: [string, Run][] = [
    [
      "numbers, booleans, strings and null in colour",
      (c) =>
        c.table([
          { a: 1, b: true, c: "str" },
          { a: 22222, b: false, c: null },
        ]),
    ],
    [
      "Burmese and CJK cells",
      (c) =>
        c.table([
          { name: "မောင်မောင်", n: 1 },
          { name: "日本語", n: 2 },
        ]),
    ],
    ["a wide header and an emoji", (c) => c.table([{ 名前: "x", ok: "✅ done", e: "e\u0301" }])],
    ["coloured keys of a Map", (c) => c.table(new Map([["လှလှ", 1n]]))],
  ];
  it.each(terminalCases)("pads %s by display width, like Node", (_label, run) => {
    expect(ours(run, true)).toBe(node(run, true));
    expect(ours(run)).toBe(node(run));
  });

  it("keeps the borders of a coloured table as wide as its cells", () => {
    const coloured = ours((c) => c.table([{ a: 1 }, { a: 22222 }]), true);
    expect(coloured).toContain("\x1b[33m1\x1b[39m");
    const lines = stripVTControlCharacters(coloured).split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "┌─────────┬───────┐",
      "│ (index) │ a     │",
      "├─────────┼───────┤",
      "│ 0       │ 1     │",
      "│ 1       │ 22222 │",
    ]);
  });

  it("validates properties", () => {
    const error = (run: Run) => {
      try {
        run(new Console({ stdout: { write: () => true } }));
      } catch (e) {
        return [(e as { code?: string }).code, (e as Error).message];
      }
      return null;
    };
    const run: Run = (c) => c.table([], "a" as never);
    expect(error(run)).toEqual(
      (() => {
        try {
          node(run);
        } catch (e) {
          return [(e as { code?: string }).code, (e as Error).message];
        }
        return null;
      })(),
    );
  });
});

describe("writing, as Node's Console[kWriteToConsole] does", () => {
  type Failure = "callback" | "late callback" | "throw" | "emit";
  type Stream = InstanceType<typeof Writable>;
  type Setup = {
    failure: Failure;
    ignoreErrors?: boolean;
    /** The program listens for 'error' itself. */
    listening?: boolean;
  };

  const brokenPipe = () => Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });

  /**
   * Logs three lines to a stream whose writes fail, then reports what the
   * stream emitted (and how many 'error' listeners each 'error' found), what
   * the log calls threw, and the 'error' listeners left at the end.
   */
  async function transcript(
    ConsoleClass: typeof Console,
    WritableClass: new (options: object) => Stream,
    setup: Setup,
  ): Promise<string[]> {
    const events: string[] = [];
    const stream = new WritableClass({
      write(_chunk: unknown, _encoding: string, callback: (error?: Error | null) => void) {
        if (setup.failure === "late callback") {
          setTimeout(() => callback(brokenPipe()), 1);
        } else {
          callback(brokenPipe());
        }
      },
    });
    if (setup.failure === "throw") {
      stream.write = () => {
        throw brokenPipe();
      };
    }
    if (setup.failure === "emit") {
      // A stream that reports the failure before `write` returns, and goes on.
      stream.write = function (this: Stream) {
        this.emit("error", brokenPipe());
        events.push("write went on after its error");
        return false;
      } as Stream["write"];
    }
    const emit = stream.emit;
    stream.emit = function (this: Stream, name: string | symbol, ...args: unknown[]): boolean {
      if (name === "error") {
        const listeners = this.listenerCount("error");
        events.push(`error (${listeners} listening)`);
        if (listeners === 0) {
          // It would be uncaught.
          return false;
        }
      }
      return emit.call(this, name, ...args);
    } as Stream["emit"];
    if (setup.listening) {
      stream.on("error", (error: { code?: string }) => events.push(`own listener ${error.code}`));
    }
    const console = new ConsoleClass({
      stdout: stream,
      stderr: stream,
      ignoreErrors: setup.ignoreErrors,
    } as ConstructorParameters<typeof Console>[0]);
    for (let line = 0; line < 3; line++) {
      try {
        console.log(`line ${line}`);
      } catch (error) {
        events.push(`log threw ${(error as { code?: string }).code}`);
      }
    }
    events.push(`after the logs: ${stream.listenerCount("error")} listening`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push(`at the end: ${stream.listenerCount("error")} listening`);
    return events;
  }

  const setups: [string, Setup][] = [
    ["a write that fails at once (a closed pipe)", { failure: "callback" }],
    ["a write that fails later", { failure: "late callback" }],
    ["a write that throws", { failure: "throw" }],
    ["a write that emits 'error' before it returns", { failure: "emit" }],
    [
      "a write that emits 'error' before it returns, ignoreErrors: false",
      { failure: "emit", ignoreErrors: false },
    ],
    ["a stream the program listens to", { failure: "callback", listening: true }],
    ["ignoreErrors: false", { failure: "callback", ignoreErrors: false }],
  ];

  it.each(setups)("keeps quiet as Node does: %s", async (_label, setup) => {
    const ourEvents = await transcript(Console, OurWritable as never, setup);
    const nodeEvents = await transcript(NodeConsole as unknown as typeof Console, Writable, setup);
    expect(ourEvents).toEqual(nodeEvents);
  });

  it("swallows EPIPE from a closed pipe: nothing is left uncaught", async () => {
    expect(await transcript(Console, OurWritable as never, { failure: "callback" })).toEqual([
      "after the logs: 0 listening",
      "error (1 listening)",
      "at the end: 0 listening",
    ]);
  });

  it("listens for an error the write emits before it returns, and stops listening after", async () => {
    expect(await transcript(Console, OurWritable as never, { failure: "emit" })).toEqual([
      "error (1 listening)",
      "write went on after its error",
      "error (1 listening)",
      "write went on after its error",
      "error (1 listening)",
      "write went on after its error",
      "after the logs: 0 listening",
      "at the end: 0 listening",
    ]);
  });

  it("gives the global console its streams on the first write, and keeps them quiet too", async () => {
    const events: string[] = [];
    const stream = new OurWritable({
      write(_chunk: unknown, _encoding: string, callback: (error?: Error | null) => void) {
        callback(brokenPipe());
      },
    });
    stream.on("close", () => events.push("close"));
    let asked = 0;
    const global = createConsole(
      () => {
        asked++;
        return stream;
      },
      () => stream,
    );
    expect(asked).toBe(0);
    global.log("a");
    global.log("b");
    expect(asked).toBe(1);
    // The stream is destroyed by the failed write; nothing is uncaught.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["close"]);
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("still writes to a stream that is no event emitter", () => {
    let out = "";
    new Console({ stdout: { write: (text: string) => (out += text) } }).log("plain");
    expect(out).toBe("plain\n");
  });
});

describe("the members Node's console carries", () => {
  const sink = () => {
    const stream = { text: "", write: (chunk: string) => ((stream.text += chunk), true) };
    return stream;
  };
  const nodeSink = () => {
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        (stream as unknown as { text: string }).text += String(chunk);
        callback();
      },
    });
    (stream as unknown as { text: string }).text = "";
    return stream as unknown as ReturnType<typeof sink>;
  };
  const hiddenNames = [
    "_stdout",
    "_stderr",
    "_ignoreErrors",
    "_stdoutErrorHandler",
    "_stderrErrorHandler",
    "_times",
  ];
  /** How each hidden member is defined: its kind and attributes. */
  const shape = (console: object) =>
    hiddenNames.map((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(console, name);
      return [
        name,
        descriptor && ("value" in descriptor ? typeof descriptor.value : "accessor"),
        descriptor?.enumerable,
        descriptor?.configurable,
        descriptor?.writable,
      ];
    });

  it("has Node's own properties and no others", () => {
    const mine = new Console(sink(), sink(), false);
    const real = new NodeConsole(nodeSink() as never, nodeSink() as never, false);
    expect(Object.keys(mine).sort()).toEqual(Object.keys(real).sort());
    expect(Object.getOwnPropertyNames(mine).sort()).toEqual(
      Object.getOwnPropertyNames(real).sort(),
    );
    expect(shape(mine)).toEqual(shape(real));
  });

  it("gives its streams and error handling by Node's names", () => {
    const out = sink();
    const err = sink();
    const console = new Console(out, err, false);
    expect(console._stdout).toBe(out);
    expect(console._stderr).toBe(err);
    expect(console._ignoreErrors).toBe(false);
    expect(typeof console._stdoutErrorHandler).toBe("function");
    expect(console._stdoutErrorHandler).not.toBe(console._stderrErrorHandler);
    const one = new Console(out);
    expect(one._stderr).toBe(out);
    expect(one._ignoreErrors).toBe(true);
  });

  it("writes to a stream a program assigns", () => {
    const transcript = (ConsoleClass: typeof Console, make: typeof sink) => {
      const first = make();
      const second = make();
      const console = new ConsoleClass(first, first);
      console.log("to the first");
      console._stdout = second;
      console.log("to the second");
      console._stderr = second;
      console.error("errors too");
      return [first.text, second.text];
    };
    const mine = transcript(Console, sink);
    expect(mine).toEqual(["to the first\n", "to the second\nerrors too\n"]);
    expect(mine).toEqual(transcript(NodeConsole as unknown as typeof Console, nodeSink));
  });

  it("refuses what is not a writable stream, with Node's error", () => {
    const failure = (ConsoleClass: typeof Console, ...args: unknown[]) => {
      try {
        new ConsoleClass(...(args as ConstructorParameters<typeof Console>));
      } catch (error) {
        return [(error as { code?: string }).code, (error as Error).name, (error as Error).message];
      }
      return null;
    };
    const attempts: unknown[][] = [
      [],
      [{ stdout: {} }],
      [sink(), {}],
      [{ stdout: sink(), stderr: 5 }],
    ];
    for (const attempt of attempts) {
      const mine = failure(Console, ...attempt);
      expect(mine?.[0]).toBe("ERR_CONSOLE_WRITABLE_STREAM");
      expect(mine).toEqual(failure(NodeConsole as unknown as typeof Console, ...attempt));
    }
  });

  it("binds the global console's streams as accessors, and has the inspector's methods", () => {
    const out = sink();
    const err = sink();
    let asked = 0;
    const global = createConsole(
      () => {
        asked += 1;
        return out;
      },
      () => err,
    );
    expect(asked).toBe(0);
    expect(global._stdout).toBe(out);
    expect(global._stderr).toBe(err);
    expect(asked).toBe(1);
    // As real Node's global console defines them (the test runner replaces it here).
    expect(shape(global).slice(0, 2)).toEqual([
      ["_stdout", "accessor", false, true, undefined],
      ["_stderr", "accessor", false, true, undefined],
    ]);
    // Assigning redirects, as with Node's.
    const other = sink();
    global._stdout = other;
    global.log("redirected");
    expect([out.text, other.text]).toEqual(["", "redirected\n"]);
    for (const name of ["profile", "profileEnd", "timeStamp"] as const) {
      expect(typeof global[name]).toBe("function");
      expect(name in new Console(out)).toBe(false);
    }
    expect(global.Console).toBe(Console);
  });
});
