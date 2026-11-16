// @vitest-environment node
// readline: line splitting, question, async iteration, the cursor helpers,
// the keypress parser and terminal line editing, each compared with real
// Node's readline where the two can be driven the same way.
import * as nodeReadline from "node:readline";
import { PassThrough as NodePassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime } from "../testing/fakeRuntime";
import readline, {
  clearLine,
  clearScreenDown,
  createInterface,
  cursorTo,
  emitKeypressEvents,
  Interface,
  moveCursor,
} from "./readline";
import { PassThrough } from "./stream";
import { ReadStream, WriteStream } from "./tty";

afterEach(() => {
  setRuntime(null);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 20; j++) {
      await Promise.resolve();
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface Impl {
  createInterface: (options: object) => {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    close(): void;
    line: string;
    cursor: number;
  };
  emitKeypressEvents: (stream: unknown) => void;
  PassThrough: new () => {
    write(chunk: string): boolean;
    end(chunk?: string): void;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
  };
}

const ours: Impl = {
  createInterface: createInterface as unknown as Impl["createInterface"],
  emitKeypressEvents,
  PassThrough: PassThrough as unknown as Impl["PassThrough"],
};
const real: Impl = {
  createInterface: nodeReadline.createInterface as unknown as Impl["createInterface"],
  emitKeypressEvents: nodeReadline.emitKeypressEvents as Impl["emitKeypressEvents"],
  PassThrough: NodePassThrough as unknown as Impl["PassThrough"],
};

/** A terminal output stand-in both implementations write to. */
function fakeOutput(columns = 80) {
  return {
    isTTY: true,
    columns,
    data: "",
    write(chunk: string, callback?: () => void) {
      this.data += chunk;
      callback?.();
      return true;
    },
    on() {},
    removeListener() {},
  };
}

async function splitLines(impl: Impl, chunks: string[], end: boolean): Promise<string[]> {
  const input = new impl.PassThrough();
  const rl = impl.createInterface({ input });
  const lines: string[] = [];
  rl.on("line", (line) => lines.push(line as string));
  for (const chunk of chunks) {
    input.write(chunk);
    await settle();
  }
  if (end) {
    input.end();
    await settle();
  }
  rl.close();
  return lines;
}

describe("non-terminal line splitting", () => {
  const cases: [string[], boolean][] = [
    [["a\nb\n"], false],
    [["a\r\nb"], true],
    [["a\r", "\nb\n"], false],
    [["a\rb\r"], false],
    [["ab", "c\nd"], true],
    [["\n\n"], false],
    [["x\r\r\ny\n"], false],
    [["héllo wörld\n"], false],
    [["no newline"], true],
    [["no newline"], false],
    [["", "\n"], false],
  ];
  for (const [chunks, end] of cases) {
    it(`${JSON.stringify(chunks)}${end ? " + end" : ""}`, async () => {
      expect(await splitLines(ours, chunks, end)).toEqual(await splitLines(real, chunks, end));
    });
  }

  it("splits a multi-byte character across chunks", async () => {
    const input = new PassThrough();
    const rl = createInterface({ input });
    const lines: string[] = [];
    rl.on("line", (line: string) => lines.push(line));
    const bytes = Buffer.from("é\n");
    input.write(bytes.subarray(0, 1));
    input.write(bytes.subarray(1));
    await settle();
    expect(lines).toEqual(["é"]);
    rl.close();
  });

  it("emits close at the end of input", async () => {
    const input = new PassThrough();
    const rl = createInterface({ input });
    let closed = 0;
    rl.on("close", () => closed++);
    input.end("x");
    await settle();
    expect(closed).toBe(1);
    expect(rl.closed).toBe(true);
    rl.close();
    expect(closed).toBe(1);
  });
});

describe("Interface", () => {
  it("is callable without new and extendable", () => {
    const input = new PassThrough();
    const plain = (Interface as unknown as (i: unknown) => Interface)(input);
    expect(plain).toBeInstanceOf(Interface);
    plain.close();
    class Mine extends Interface {
      mine = true;
    }
    const mine = new Mine({ input });
    expect(mine).toBeInstanceOf(Interface);
    expect(mine.mine).toBe(true);
    expect(mine.getPrompt()).toBe("> ");
    mine.close();
    expect(readline.createInterface).toBe(createInterface);
    expect(readline.promises.Interface.name).toBe("Interface");
  });

  it("validates its options", () => {
    const input = new PassThrough();
    expect(() => createInterface({ input, completer: 1 as never })).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
    );
    expect(() => createInterface({ input, historySize: -1 })).toThrow(RangeError);
    expect(() => createInterface({ input, history: "x" as never })).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("asks a question and answers it with the next line", async () => {
    const input = new PassThrough();
    const output = fakeOutput();
    const rl = createInterface({ input, output, terminal: false });
    const lines: string[] = [];
    rl.on("line", (line: string) => lines.push(line));
    const answer = new Promise<string>((resolve) => rl.question("Name? ", resolve));
    expect(output.data).toBe("Name? ");
    input.write("Bob\nnext\n");
    expect(await answer).toBe("Bob");
    await settle();
    expect(lines).toEqual(["next"]);
    expect(rl.getPrompt()).toBe("> ");
    rl.close();
    expect(() => rl.question("again", () => {})).toThrow(
      expect.objectContaining({ code: "ERR_USE_AFTER_CLOSE", message: "readline was closed" }),
    );
    expect(() => rl.write("x")).toThrow(expect.objectContaining({ code: "ERR_USE_AFTER_CLOSE" }));
  });

  it("cancels a question on abort", async () => {
    const input = new PassThrough();
    const rl = createInterface({ input, output: fakeOutput(), terminal: false });
    const controller = new AbortController();
    let answered = false;
    rl.question("Q? ", { signal: controller.signal }, () => {
      answered = true;
    });
    controller.abort();
    const lines: string[] = [];
    rl.on("line", (line: string) => lines.push(line));
    input.write("later\n");
    await settle();
    expect(answered).toBe(false);
    expect(lines).toEqual(["later"]);
    rl.close();
  });

  it("supports util.promisify(rl.question)", async () => {
    const { promisify } = await import("./util");
    const input = new PassThrough();
    const rl = createInterface({ input, terminal: false });
    const ask = promisify(rl.question).bind(rl) as (q: string) => Promise<string>;
    const answer = ask("? ");
    input.write("yes\n");
    expect(await answer).toBe("yes");
    rl.close();
  });

  it("iterates lines asynchronously until close", async () => {
    const input = new PassThrough();
    const rl = createInterface({ input });
    // As in Node, lines emitted before iteration starts are not buffered.
    setTimeout(() => input.end("one\ntwo\r\nthree"), 1);
    const seen: string[] = [];
    for await (const line of rl) {
      seen.push(line);
    }
    expect(seen).toEqual(["one", "two", "three"]);
  });

  it("stops iterating at break", async () => {
    const input = new PassThrough();
    const rl = createInterface({ input });
    setTimeout(() => input.write("a\nb\n"), 1);
    for await (const line of rl) {
      expect(line).toBe("a");
      break;
    }
    rl.close();
  });

  it("closes when its signal aborts", async () => {
    const controller = new AbortController();
    const rl = createInterface({ input: new PassThrough(), signal: controller.signal });
    controller.abort();
    expect(rl.closed).toBe(true);
    const already = createInterface({
      input: new PassThrough(),
      signal: AbortSignal.abort(),
    });
    await settle();
    expect(already.closed).toBe(true);
  });

  it("closes with Symbol.dispose", () => {
    const rl = createInterface({ input: new PassThrough() });
    (rl as unknown as Record<symbol, () => void>)[
      (Symbol as unknown as { dispose: symbol }).dispose
    ]();
    expect(rl.closed).toBe(true);
  });
});

describe("cursor helpers", () => {
  it("write the same sequences as Node", () => {
    const calls: [string, unknown[]][] = [
      ["cursorTo", [0]],
      ["cursorTo", [4, 2]],
      ["moveCursor", [3, 0]],
      ["moveCursor", [-3, -2]],
      ["moveCursor", [0, 5]],
      ["clearLine", [-1]],
      ["clearLine", [0]],
      ["clearLine", [1]],
      ["clearScreenDown", []],
    ];
    const mine = { cursorTo, moveCursor, clearLine, clearScreenDown } as Record<
      string,
      (...args: unknown[]) => boolean
    >;
    const theirs = nodeReadline as unknown as Record<string, (...args: unknown[]) => boolean>;
    for (const [name, args] of calls) {
      const a = fakeOutput();
      const b = fakeOutput();
      expect(mine[name](a, ...args)).toBe(theirs[name](b, ...args));
      expect([name, args, a.data]).toEqual([name, args, b.data]);
    }
  });

  it("call back with no stream and validate", async () => {
    let called = 0;
    expect(cursorTo(null, 1, () => called++)).toBe(true);
    expect(moveCursor(fakeOutput(), 0, 0, () => called++)).toBe(true);
    await settle();
    expect(called).toBe(2);
    expect(() => cursorTo(fakeOutput(), undefined, 1)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_CURSOR_POS" }),
    );
    expect(() => cursorTo(fakeOutput(), NaN)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
    );
    expect(() => clearLine(fakeOutput(), 0, 1)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });
});

describe("emitKeypressEvents", () => {
  const sequences = [
    "a",
    "A",
    "1",
    " ",
    ".",
    "\r",
    "\n",
    "\t",
    "\x7f",
    "\b",
    "\x03",
    "\x01",
    "\x1a",
    "\x1b[A",
    "\x1b[B",
    "\x1b[C",
    "\x1b[D",
    "\x1b[E",
    "\x1b[F",
    "\x1b[H",
    "\x1bOA",
    "\x1bOH",
    "\x1b[1~",
    "\x1b[2~",
    "\x1b[3~",
    "\x1b[4~",
    "\x1b[5~",
    "\x1b[6~",
    "\x1b[7~",
    "\x1b[8~",
    "\x1b[[5~",
    "\x1bOP",
    "\x1bOQ",
    "\x1b[11~",
    "\x1b[15~",
    "\x1b[17~",
    "\x1b[21~",
    "\x1b[24~",
    "\x1b[[A",
    "\x1b[[E",
    "\x1b[1;5C",
    "\x1b[1;2A",
    "\x1b[1;3D",
    "\x1b[5D",
    "\x1b[3;5~",
    "\x1b[24;5~",
    "\x1b[Z",
    "\x1b[a",
    "\x1b[e",
    "\x1bOa",
    "\x1b[2$",
    "\x1b[5^",
    "\x1b[200~",
    "\x1b[201~",
    "\x1bb",
    "\x1bB",
    "\x1bf",
    "\x1b\x7f",
    "\x1b\r",
    "\x1b ",
    "\x1b\x1b[A",
    "\x1b[Q",
    "\x1b[9z",
    "é",
    "😀",
    "abc",
    "\x1b[A\x1b[B",
  ];

  function keys(impl: Impl, sequence: string): unknown[] {
    const stream = new impl.PassThrough();
    impl.emitKeypressEvents(stream);
    const seen: unknown[] = [];
    stream.on("keypress", (s, key) => seen.push([s, { ...(key as object) }]));
    stream.write(sequence);
    return seen;
  }

  for (const sequence of sequences) {
    it(`${JSON.stringify(sequence)}`, async () => {
      const mine = keys(ours, sequence);
      const theirs = keys(real, sequence);
      await settle();
      expect(mine).toEqual(theirs);
    });
  }

  it("emits a lone escape after the timeout", async () => {
    const stream = new PassThrough();
    emitKeypressEvents(stream);
    const seen: unknown[] = [];
    stream.on("keypress", (s: unknown, key: { name: string }) => seen.push([s, key.name]));
    stream.write("\x1b");
    await settle();
    expect(seen).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(seen).toEqual([[undefined, "escape"]]);
  });
});

describe("terminal line editing", () => {
  interface Run {
    lines: string[];
    output: string;
    line: string;
    cursor: number;
    closed: boolean;
    history: string[][];
  }

  async function edit(
    impl: Impl,
    keystrokes: string[],
    options: { columns?: number; completer?: unknown; prompt?: string; sigint?: boolean } = {},
  ): Promise<Run> {
    const input = new impl.PassThrough() as InstanceType<Impl["PassThrough"]> & {
      setRawMode?: (mode: boolean) => void;
      isRaw?: boolean;
      isTTY?: boolean;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (mode) => {
      input.isRaw = mode;
    };
    const output = fakeOutput(options.columns ?? 80);
    const rl = impl.createInterface({
      input,
      output,
      terminal: true,
      completer: options.completer,
      prompt: options.prompt ?? "> ",
    });
    const lines: string[] = [];
    const history: string[][] = [];
    let closed = false;
    rl.on("line", (line) => lines.push(line as string));
    rl.on("history", (h) => history.push([...(h as string[])]));
    rl.on("close", () => {
      closed = true;
    });
    if (options.sigint) {
      rl.on("SIGINT", () => lines.push("<SIGINT>"));
    }
    (rl as unknown as { prompt(): void }).prompt();
    for (const keys of keystrokes) {
      input.write(keys);
      await settle();
    }
    const run = { lines, output: output.data, line: rl.line, cursor: rl.cursor, closed, history };
    rl.close();
    return run;
  }

  const cases: [string, string[], Parameters<typeof edit>[2]?][] = [
    ["typing and enter", ["hello", "\r"]],
    ["left arrows then insert", ["abc", "\x1b[D", "\x1b[D", "X", "\r"]],
    ["right arrow", ["abc", "\x1b[D\x1b[D", "\x1b[C", "Y", "\r"]],
    ["backspace", ["abcd", "\x7f", "\x7f", "\r"]],
    ["backspace mid-line", ["abcd", "\x1b[D", "\x7f", "\r"]],
    ["delete key", ["abcd", "\x1b[H", "\x1b[3~", "\r"]],
    ["home and end", ["abc", "\x1b[H", "1", "\x1b[F", "2", "\r"]],
    ["ctrl+a / ctrl+e", ["abc", "\x01", "X", "\x05", "Y", "\r"]],
    ["ctrl+b / ctrl+f", ["abc", "\x02", "\x02", "\x06", "Z", "\r"]],
    ["ctrl+u", ["hello world", "\x1b[D\x1b[D", "\x15", "\r"]],
    ["ctrl+k", ["hello world", "\x01", "\x1b[C\x1b[C", "\x0b", "\r"]],
    ["ctrl+w", ["hello big world", "\x17", "\r"]],
    ["ctrl+w twice", ["hello big world", "\x17", "\x17", "\r"]],
    ["meta+b / meta+f", ["one two three", "\x1bb", "\x1bb", "X", "\x1bf", "Y", "\r"]],
    ["ctrl+left / ctrl+right", ["one two", "\x1b[1;5D", "_", "\x1b[1;5C", "!", "\r"]],
    ["meta+backspace", ["one two", "\x1b\x7f", "\r"]],
    ["meta+d", ["one two", "\x01", "\x1bd", "\r"]],
    ["ctrl+h", ["ab", "\x08", "\r"]],
    ["ctrl+d deletes right", ["ab", "\x01", "\x04", "\r"]],
    ["ctrl+d on an empty line closes", ["\x04"]],
    ["ctrl+c without a listener closes", ["abc", "\x03"]],
    ["ctrl+c with a listener emits SIGINT", ["abc", "\x03"], { sigint: true }],
    ["ctrl+l redraws", ["abc", "\x0c"]],
    ["history up and down", ["one", "\r", "two", "\r", "\x1b[A", "\x1b[A", "\x1b[B", "\r"]],
    ["history substring search", ["apple", "\r", "banana", "\r", "ap", "\x1b[A", "\r"]],
    ["history ctrl+p / ctrl+n", ["x", "\r", "y", "\r", "\x10", "\x10", "\x0e", "\r"]],
    ["duplicate lines in history", ["a", "\r", "a", "\r", "b", "\r"]],
    ["blank lines are not history", ["  ", "\r", "", "\r"]],
    ["undo and redo", ["abc", "\x7f", "\x1f", "\x1f", "\x1e", "\r"]],
    ["pasted text with newlines", ["one\ntwo\nthr"]],
    ["\\r\\n counts once", ["a\r\n", "b\r"]],
    ["enter key", ["a\n"]],
    ["escape is ignored", ["ab\x1b\x1b", "c\r"]],
    // One character per write: Node after 22 inserts a multi-character chunk at once.
    ["wrapping at the width", [..."0123456789abcdef", "\x1b[D", "X", "\r"], { columns: 10 }],
    ["wide characters", ["日本語", "\x1b[D", "x", "\r"]],
    ["astral characters", ["a😀b", "\x1b[D", "\x1b[D", "\x7f", "\r"]],
    ["tabs", ["a\tb", "\r"]],
    ["custom prompt", ["x", "\r"], { prompt: "$ " }],
    ["prompt with colours", ["x", "\x1b[D", "y", "\r"], { prompt: "\x1b[32m>\x1b[39m " }],
  ];

  for (const [name, keystrokes, options] of cases) {
    it(`${name}`, async () => {
      const mine = await edit(ours, keystrokes, options);
      const theirs = await edit(real, keystrokes, options);
      expect(mine).toEqual(theirs);
    });
  }

  const completer = (line: string): [string[], string] => {
    const words = ["apple", "apricot", "banana"];
    const hits = words.filter((word) => word.startsWith(line));
    return [hits.length ? hits : words, line];
  };

  const completionCases: [string, string[]][] = [
    ["completes the common prefix", ["a", "\t"]],
    ["lists on a second tab", ["ap", "\t", "\t"]],
    ["completes a unique match", ["b", "\t", "\r"]],
    ["lists everything for no match", ["z", "\t", "\t"]],
  ];
  for (const [name, keystrokes] of completionCases) {
    it(`tab completion: ${name}`, async () => {
      const mine = await edit(ours, keystrokes, { completer });
      const theirs = await edit(real, keystrokes, { completer });
      expect(mine).toEqual(theirs);
    });
  }

  it("tab completion with a callback completer", async () => {
    const callbackCompleter = (line: string, cb: (e: null, r: [string[], string]) => void) => {
      cb(null, completer(line));
    };
    const mine = await edit(ours, ["ba", "\t", "\r"], { completer: callbackCompleter });
    const theirs = await edit(real, ["ba", "\t", "\r"], { completer: callbackCompleter });
    expect(mine).toEqual(theirs);
    expect(mine.lines).toEqual(["banana"]);
  });

  it("drives a real tty on the fake runtime", async () => {
    const fake = createFakeRuntime({ tty: true });
    setRuntime(fake);
    const input = new ReadStream(0);
    const output = new WriteStream(1);
    const rl = createInterface({ input, output });
    expect(rl.terminal).toBe(true);
    expect(fake.rawMode).toBe(true);
    const lines: string[] = [];
    rl.on("line", (line: string) => lines.push(line));
    rl.setPrompt("? ");
    rl.prompt();
    fake.feedStdin("hello");
    fake.feedStdin("\x1b[D\x1b[D");
    fake.feedStdin("X\r");
    await settle();
    expect(lines).toEqual(["helXlo"]);
    expect(fake.stdout()).toContain("? \x1b[3Ghello");
    expect(rl.getCursorPos()).toEqual({ cols: 2, rows: 0 });
    let resized = 0;
    output.on("resize", () => resized++);
    fake.resize(40, 10);
    expect(resized).toBe(1);
    rl.close();
    expect(fake.rawMode).toBe(false);
    input.destroy();
    await settle();
    expect(fake.refCount).toBe(0);
  });
});
