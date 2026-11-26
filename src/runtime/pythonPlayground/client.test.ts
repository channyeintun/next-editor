// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PythonPlaygroundClient,
  PythonPlaygroundServiceError,
  pickPythonRunEntry,
  type PythonEngine,
} from "./client";
import { PYTHON_STOPPED_DETAIL, PYTHON_TIME_LIMIT_DETAIL } from "./interpreter";
import type { PythonPlaygroundRunResult } from "./types";

const MAIN = { path: "main.py", content: 'print("ok")\n' };
const HELPERS = { path: "helpers.py", content: "" };
const OK: PythonPlaygroundRunResult = { status: "success", output: "ok\n" };

type FakeEngine = { [Key in keyof PythonEngine]: ReturnType<typeof vi.fn<PythonEngine[Key]>> };

/** An engine that loads at once and answers every run with `OK`, unless told otherwise. */
function fakeEngine(overrides: Partial<PythonEngine> = {}): FakeEngine {
  return {
    load: vi.fn<PythonEngine["load"]>(overrides.load ?? (async () => {})),
    run: vi.fn<PythonEngine["run"]>(overrides.run ?? (async () => OK)),
    terminate: vi.fn<PythonEngine["terminate"]>(overrides.terminate ?? (() => {})),
  };
}

/** A client whose engines are these, in order, and then plain ones; `made` is every one it asked for. */
function clientWith(...engines: FakeEngine[]) {
  const made: FakeEngine[] = [];
  const client = new PythonPlaygroundClient({
    createEngine: () => {
      const engine = engines.shift() ?? fakeEngine();
      made.push(engine);
      return engine;
    },
    hardStopMs: 50,
  });
  return { client, made };
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
