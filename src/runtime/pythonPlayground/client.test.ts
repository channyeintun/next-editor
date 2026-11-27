// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PythonPlaygroundClient,
  PythonPlaygroundServiceError,
  pickPythonRunEntry,
  type PythonEngine,
} from "./client";
import type { PlaygroundRunTerminal } from "../playgroundLanguage";
import { PYTHON_STOPPED_DETAIL, PYTHON_TIME_LIMIT_DETAIL } from "./interpreter";
import type { PythonTerminalLink } from "./terminalMemory";
import type { PythonPlaygroundRunResult } from "./types";

const MAIN = { path: "main.py", content: 'print("ok")\n' };
const HELPERS = { path: "helpers.py", content: "" };
const OK: PythonPlaygroundRunResult = { status: "success", output: "ok\n" };

type EngineCall = "load" | "run" | "terminate";
type FakeEngine = { [Key in EngineCall]: ReturnType<typeof vi.fn<PythonEngine[Key]>> } & Pick<
  PythonEngine,
  "offThread"
>;

/** An engine that loads at once and answers every run with `OK`, unless told otherwise. */
function fakeEngine(overrides: Partial<PythonEngine> = {}): FakeEngine {
  return {
    offThread: overrides.offThread,
    load: vi.fn<PythonEngine["load"]>(overrides.load ?? (async () => {})),
    run: vi.fn<PythonEngine["run"]>(overrides.run ?? (async () => OK)),
    terminate: vi.fn<PythonEngine["terminate"]>(overrides.terminate ?? (() => {})),
  };
}

/**
 * The page's end of a terminal, as a test moves it: what the program has
 * printed, whether it waits, and the answers the client gave it.
 */
function fakeTerminalLink() {
  const state = { output: "", waiting: false, answers: [] as (string | null)[] };
  const link: PythonTerminalLink = {
    memory: new SharedArrayBuffer(4),
    view: {
      isWaiting: () => state.waiting,
      output: () => state.output,
      answer: (line) => {
        state.answers.push(line);
        state.waiting = false;
      },
    },
  };
  return { state, link };
}

/** The hard stop of these tests: long enough for a test's own steps, short enough to wait out. */
const HARD_STOP_MS = 100;

/** A client whose engines are these, in order, and then plain ones; `made` is every one it asked for. */
function clientWith(...engines: FakeEngine[]) {
  const made: FakeEngine[] = [];
  const terminal = fakeTerminalLink();
  const client = new PythonPlaygroundClient({
    createEngine: () => {
      const engine = engines.shift() ?? fakeEngine();
      made.push(engine);
      return engine;
    },
    hardStopMs: HARD_STOP_MS,
    openTerminal: () => terminal.link,
    terminalPollMs: 1,
  });
  return { client, made, terminal: terminal.state, memory: terminal.link.memory };
}

/** `vi.waitFor`, looking as often as the client reads its terminal. */
const soon = (assertion: () => void) => vi.waitFor(assertion, { interval: 1 });

/** A terminal that records what it was shown and is asked for lines by hand. */
function fakeRunTerminal() {
  const printed: string[] = [];
  const asked: ((line: string | null) => void)[] = [];
  const terminal: PlaygroundRunTerminal = {
    print: (output) => void printed.push(output),
    readLine: () => new Promise((resolve) => void asked.push(resolve)),
  };
  return { terminal, printed, asked };
}

/** A program that ends when the test says so. */
function pendingRun() {
  let finish: (result: PythonPlaygroundRunResult) => void = () => {};
  const run = () =>
    new Promise<PythonPlaygroundRunResult>((resolve) => {
      finish = resolve;
    });
  return { run, finish: (result: PythonPlaygroundRunResult) => finish(result) };
}

/** A promise that never settles: a program that never returns. */
const never = <Value>() => new Promise<Value>(() => {});

async function serviceErrorOf(run: Promise<unknown>): Promise<PythonPlaygroundServiceError> {
  const error = await run.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(PythonPlaygroundServiceError);
  return error as PythonPlaygroundServiceError;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pickPythonRunEntry", () => {
  it("starts from main.py and ignores the files that are not scripts", () => {
    expect(pickPythonRunEntry([{ path: "scores.csv", content: "" }, HELPERS, MAIN])).toBe(MAIN);
  });

  it("refuses a workspace with no script, saying what to add", () => {
    expect(() => pickPythonRunEntry([{ path: "README.md", content: "" }])).toThrow(
      "Add a .py file to run this lesson",
    );
  });

  it("refuses to guess among several scripts", () => {
    expect(() => pickPythonRunEntry([HELPERS, { path: "other.py", content: "" }])).toThrow(
      "Name the file this lesson runs `main.py`",
    );
  });
});

describe("PythonPlaygroundClient", () => {
  it("runs the script on a loaded interpreter, with every file beside it", async () => {
    const { client, made } = clientWith();

    await expect(client.run({ files: [MAIN, HELPERS] })).resolves.toEqual(OK);

    expect(made[0].load).toHaveBeenCalledTimes(1);
    expect(made[0].run).toHaveBeenCalledWith([MAIN, HELPERS], "main.py");
  });

  // An interpreter remembers what a program did to it, so none runs two.
  it("ends the interpreter a run used and starts the next one ahead of time", async () => {
    const { client, made } = clientWith();

    await client.run({ files: [MAIN] });

    expect(made).toHaveLength(2);
    expect(made[0].terminate).toHaveBeenCalledTimes(1);
    expect(made[1].load).toHaveBeenCalledTimes(1);
    expect(made[1].run).not.toHaveBeenCalled();
    expect(made[1].terminate).not.toHaveBeenCalled();
  });

  it("runs the next program on the interpreter started for it", async () => {
    const { client, made } = clientWith();

    await client.run({ files: [MAIN] });
    await client.run({ files: [MAIN] });

    expect(made).toHaveLength(3);
    expect(made[1].run).toHaveBeenCalledTimes(1);
    expect(made[1].terminate).toHaveBeenCalledTimes(1);
  });

  it("refuses a workspace with no script before starting anything", async () => {
    const { client, made } = clientWith();

    const error = await serviceErrorOf(client.run({ files: [] }));

    expect(error.kind).toBe("invalid-source");
    expect(made).toHaveLength(0);
  });

  it("supersedes the run in flight: its interpreter is ended and it reports aborted", async () => {
    const stuck = fakeEngine({ run: () => never() });
    const { client, made } = clientWith(stuck);

    const first = serviceErrorOf(client.run({ files: [MAIN] }));
    await vi.waitFor(() => expect(stuck.run).toHaveBeenCalled());
    const second = client.run({ files: [MAIN] });

    expect((await first).kind).toBe("aborted");
    expect(stuck.terminate).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toEqual(OK);
    expect(made[1].run).toHaveBeenCalledTimes(1);
  });

  it("stops a program that never returns when the dock cancels", async () => {
    const stuck = fakeEngine({ run: () => never() });
    const { client, made } = clientWith(stuck);

    const run = serviceErrorOf(client.run({ files: [MAIN] }));
    await vi.waitFor(() => expect(stuck.run).toHaveBeenCalled());
    client.dispose();

    expect((await run).kind).toBe("aborted");
    expect(stuck.terminate).toHaveBeenCalledTimes(1);
    // Nothing is started for a lesson the learner may have left.
    expect(made).toHaveLength(1);
  });

  it("never begins a program that was superseded while its interpreter was starting", async () => {
    let finishLoading = () => {};
    const slow = fakeEngine({
      load: () =>
        new Promise<void>((resolve) => {
          finishLoading = resolve;
        }),
    });
    const { client } = clientWith(slow);

    const run = serviceErrorOf(client.run({ files: [MAIN] }));
    client.dispose();
    finishLoading();

    expect((await run).kind).toBe("aborted");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slow.run).not.toHaveBeenCalled();
  });

  it("ends the interpreter it started ahead when the lesson is left", async () => {
    const { client, made } = clientWith();

    await client.run({ files: [MAIN] });
    client.dispose();

    expect(made[1].terminate).toHaveBeenCalledTimes(1);
  });

  it("reports an interpreter that would not load, and starts none in its place", async () => {
    const broken = fakeEngine({ load: () => Promise.reject(new Error("offline")) });
    const { client, made } = clientWith(broken);

    const error = await serviceErrorOf(client.run({ files: [MAIN] }));

    expect(error.kind).toBe("unavailable");
    expect(error.message).toContain("offline");
    expect(broken.run).not.toHaveBeenCalled();
    expect(broken.terminate).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(1);
    // The next Run tries again, on an interpreter of its own.
    await expect(client.run({ files: [MAIN] })).resolves.toEqual(OK);
  });

  it("tells an interpreter that died under a program as the program's error", async () => {
    const dying = fakeEngine({ run: () => Promise.reject(new Error("worker stopped")) });
    const { client, made } = clientWith(dying);

    await expect(client.run({ files: [MAIN] })).resolves.toEqual({
      status: "runtime-error",
      output: "",
      exitDetail: PYTHON_STOPPED_DETAIL,
    });
    expect(dying.terminate).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(2);
  });

  // `time.sleep(3600)` waits inside one call, where the interpreter's own
  // limit cannot reach it.
  it("ends a run the interpreter could not stop by itself", async () => {
    const stuck = fakeEngine({ run: () => never() });
    const { client } = clientWith(stuck);

    await expect(client.run({ files: [MAIN] })).resolves.toEqual({
      status: "runtime-error",
      output: "",
      exitDetail: PYTHON_TIME_LIMIT_DETAIL,
    });
    expect(stuck.terminate).toHaveBeenCalledTimes(1);
  });

  it("does not count the interpreter's start against the program's time", async () => {
    vi.useFakeTimers();
    let finishLoading = () => {};
    const slow = fakeEngine({
      load: () =>
        new Promise<void>((resolve) => {
          finishLoading = resolve;
        }),
    });
    const { client } = clientWith(slow);

    const run = client.run({ files: [MAIN] });
    await vi.advanceTimersByTimeAsync(60_000);
    finishLoading();

    await expect(run).resolves.toEqual(OK);
  });

  describe("on a terminal", () => {
    it("gives an interpreter off this thread the terminal's memory", async () => {
      const { client, made, memory } = clientWith(fakeEngine({ offThread: true }));

      await client.run({ files: [MAIN] }, fakeRunTerminal().terminal);

      expect(made[0].run).toHaveBeenCalledWith([MAIN], "main.py", memory);
    });

    // A program that blocks this thread to wait would freeze the page.
    it("gives an interpreter on this thread none, and a run with no terminal none", async () => {
      const { client, made } = clientWith(fakeEngine(), fakeEngine({ offThread: true }));

      await client.run({ files: [MAIN] }, fakeRunTerminal().terminal);
      await client.run({ files: [MAIN] });

      expect(made[0].run).toHaveBeenCalledWith([MAIN], "main.py");
      expect(made[1].run).toHaveBeenCalledWith([MAIN], "main.py");
    });

    it("prints the program's output as it grows, whole each time", async () => {
      const program = pendingRun();
      const { client, terminal } = clientWith(fakeEngine({ offThread: true, run: program.run }));
      const { terminal: runTerminal, printed } = fakeRunTerminal();

      const run = client.run({ files: [MAIN] }, runTerminal);
      terminal.output = "one\n";
      await soon(() => expect(printed).toEqual(["one\n"]));
      terminal.output = "one\ntwo\n";
      await soon(() => expect(printed).toEqual(["one\n", "one\ntwo\n"]));
      program.finish({ status: "success", output: "one\ntwo\n" });

      await expect(run).resolves.toEqual({ status: "success", output: "one\ntwo\n" });
      // Nothing is read once the run is over.
      terminal.output = "late";
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(printed).toHaveLength(2);
    });

    it("asks for a line once when the program waits, after printing its prompt", async () => {
      const program = pendingRun();
      const { client, terminal } = clientWith(fakeEngine({ offThread: true, run: program.run }));
      const { terminal: runTerminal, printed, asked } = fakeRunTerminal();

      const run = client.run({ files: [MAIN] }, runTerminal);
      terminal.output = "Name: ";
      terminal.waiting = true;
      await soon(() => expect(asked).toHaveLength(1));
      expect(printed).toEqual(["Name: "]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(asked).toHaveLength(1);

      asked[0]("Chan");
      await soon(() => expect(terminal.answers).toEqual(["Chan"]));
      program.finish(OK);
      await expect(run).resolves.toEqual(OK);
    });

    it.each<[string, PlaygroundRunTerminal["readLine"]]>([
      ["answers with no line", async () => null],
      ["fails to give one", () => Promise.reject(new Error("closed"))],
    ])("tells the program its input is over when the terminal %s", async (_, readLine) => {
      const program = pendingRun();
      const { client, terminal } = clientWith(fakeEngine({ offThread: true, run: program.run }));

      const run = client.run({ files: [MAIN] }, { print: () => {}, readLine });
      terminal.waiting = true;
      await soon(() => expect(terminal.answers).toEqual([null]));
      program.finish(OK);

      await expect(run).resolves.toEqual(OK);
    });

    // The limit is on the program, not on how long a learner takes to type.
    it("does not count the wait for a line against the program's time", async () => {
      const program = pendingRun();
      const { client, terminal } = clientWith(fakeEngine({ offThread: true, run: program.run }));
      const { terminal: runTerminal, asked } = fakeRunTerminal();

      const run = client.run({ files: [MAIN] }, runTerminal);
      terminal.output = "Name: ";
      terminal.waiting = true;
      await soon(() => expect(asked).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, HARD_STOP_MS * 3));
      asked[0]("Chan");
      await soon(() => expect(terminal.answers).toEqual(["Chan"]));
      program.finish(OK);

      await expect(run).resolves.toEqual(OK);
    });

    it("counts the time again once the line is in, and keeps what the program printed", async () => {
      const stuck = fakeEngine({ offThread: true, run: () => never() });
      const { client, terminal } = clientWith(stuck);
      const { terminal: runTerminal, asked } = fakeRunTerminal();

      const run = client.run({ files: [MAIN] }, runTerminal);
      terminal.output = "Name: ";
      terminal.waiting = true;
      await soon(() => expect(asked).toHaveLength(1));
      terminal.output = "Name: Chan\n";
      asked[0]("Chan");

      await expect(run).resolves.toEqual({
        status: "runtime-error",
        output: "Name: Chan\n",
        exitDetail: PYTHON_TIME_LIMIT_DETAIL,
      });
      expect(stuck.terminate).toHaveBeenCalledTimes(1);
    });

    it("keeps what the program printed when its interpreter dies", async () => {
      let die: (cause: Error) => void = () => {};
      const dying = fakeEngine({
        offThread: true,
        run: () =>
          new Promise<PythonPlaygroundRunResult>((_, reject) => {
            die = reject;
          }),
      });
      const { client, terminal } = clientWith(dying);

      const run = client.run({ files: [MAIN] }, fakeRunTerminal().terminal);
      await soon(() => expect(dying.run).toHaveBeenCalled());
      terminal.output = "before\n";
      die(new Error("worker stopped"));

      await expect(run).resolves.toEqual({
        status: "runtime-error",
        output: "before\n",
        exitDetail: PYTHON_STOPPED_DETAIL,
      });
    });

    it("ends a program that waits for a line when a newer run starts, and drops a late line", async () => {
      const waiting = fakeEngine({ offThread: true, run: () => never() });
      const { client, terminal } = clientWith(waiting);
      const { terminal: runTerminal, asked } = fakeRunTerminal();

      const first = serviceErrorOf(client.run({ files: [MAIN] }, runTerminal));
      terminal.waiting = true;
      await soon(() => expect(asked).toHaveLength(1));
      const second = client.run({ files: [MAIN] });

      expect((await first).kind).toBe("aborted");
      expect(waiting.terminate).toHaveBeenCalledTimes(1);
      await expect(second).resolves.toEqual(OK);
      asked[0]("too late");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(terminal.answers).toEqual([]);
    });

    it("ends a program that waits for a line when the lesson is left", async () => {
      const waiting = fakeEngine({ offThread: true, run: () => never() });
      const { client, terminal } = clientWith(waiting);
      const { terminal: runTerminal, asked } = fakeRunTerminal();

      const run = serviceErrorOf(client.run({ files: [MAIN] }, runTerminal));
      terminal.waiting = true;
      await soon(() => expect(asked).toHaveLength(1));
      client.dispose();

      expect((await run).kind).toBe("aborted");
      expect(waiting.terminate).toHaveBeenCalledTimes(1);
    });
  });

  it("refuses a result that does not match the contract", async () => {
    const odd = fakeEngine({
      run: async () =>
        ({ status: "success", output: "", exitCode: 1 }) as PythonPlaygroundRunResult,
    });
    const { client } = clientWith(odd);

    const error = await serviceErrorOf(client.run({ files: [MAIN] }));

    expect(error.kind).toBe("unavailable");
    expect(error.message).toContain("does not match the contract");
  });
});
