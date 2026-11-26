// @vitest-environment node
import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  bootPythonInterpreter,
  PYTHON_MAX_OUTPUT_BYTES,
  PYTHON_OUTPUT_LIMIT_DETAIL,
  PYTHON_TIME_LIMIT_DETAIL,
  type PythonInterpreter,
} from "./interpreter";
import { parsePythonPlaygroundRunResult } from "./types";

/**
 * The real interpreter: Pyodide runs under Node as it does in a worker, from
 * the files of the installed package. Nothing here is a stand-in, so a Pyodide
 * upgrade that changes a traceback, a stream's order or the interrupt check
 * fails here and not in a learner's console.
 *
 * One interpreter serves the cases that do not depend on what an earlier
 * program left behind; starting one takes about a second.
 */
describe("the Python interpreter", () => {
  let python: PythonInterpreter;
  const run = (source: string, files: Record<string, string> = {}) =>
    python.run(
      [
        { path: "main.py", content: source },
        ...Object.entries(files).map(([path, content]) => ({ path, content })),
      ],
      "main.py",
    );

  beforeAll(async () => {
    python = await bootPythonInterpreter({ maxRunMs: 1_500 });
  }, 60_000);

  it("is CPython 3.14", async () => {
    const result = await run("import sys\nprint(sys.version_info[:2], sys.implementation.name)\n");
    expect(result).toEqual({ status: "success", output: "(3, 14) cpython\n" });
  });

  it("keeps standard output and standard error in the order they were written", async () => {
    const result = await run(
      [
        "import sys",
        'print("one")',
        'print("two", file=sys.stderr)',
        'print("three", end="")',
        'print(" four", file=sys.stderr)',
      ].join("\n"),
    );
    expect(result).toEqual({ status: "success", output: "one\ntwo\nthree four\n" });
  });

  it("imports the lesson's other scripts and opens its other files", async () => {
    const result = await run(
      'from shapes.circle import area\nprint(area(1), open("data/notes.txt").read())\n',
      {
        "shapes/circle.py": "def area(radius):\n    return round(3.14159 * radius**2, 2)\n",
        "data/notes.txt": "remember",
      },
    );
    expect(result).toEqual({ status: "success", output: "3.14 remember\n" });
  });

  it("runs the script as __main__, from the lesson's folder", async () => {
    const result = await run(
      "import os, sys\nprint(__name__, __file__, os.getcwd(), sys.argv, sys.path[0])\n",
    );
    expect(result.output).toBe("__main__ /lesson/main.py /lesson ['/lesson/main.py'] /lesson\n");
  });

  it("prints an uncaught exception's traceback from the script down, and exits 1", async () => {
    const result = await run('print("before")\nimport broken\n', {
      "broken.py": "def divide():\n    return 1 / 0\n\ndivide()\n",
    });
    expect(result).toEqual({
      status: "runtime-error",
      exitCode: 1,
      output: [
        "before",
        "Traceback (most recent call last):",
        '  File "/lesson/main.py", line 2, in <module>',
        "    import broken",
        '  File "/lesson/broken.py", line 4, in <module>',
        "    divide()",
        "    ~~~~~~^^",
        '  File "/lesson/broken.py", line 2, in divide',
        "    return 1 / 0",
        "           ~~^~~",
        "ZeroDivisionError: division by zero",
        "",
      ].join("\n"),
    });
  });

  it("reports a syntax error the way python does, with no runner frames", async () => {
    const result = await run('print("never printed")\nprint("open"\n');
    expect(result).toEqual({
      status: "runtime-error",
      exitCode: 1,
      output: [
        '  File "/lesson/main.py", line 2',
        '    print("open"',
        "         ^",
        "SyntaxError: '(' was never closed",
        "",
      ].join("\n"),
    });
  });

  it("answers sys.exit with the status a shell would read", async () => {
    expect(await run("import sys\nsys.exit()\n")).toEqual({ status: "success", output: "" });
    expect(await run("import sys\nsys.exit(3)\n")).toEqual({
      status: "runtime-error",
      output: "",
      exitCode: 3,
    });
    expect(await run('import sys\nsys.exit("gave up")\n')).toEqual({
      status: "runtime-error",
      output: "gave up\n",
      exitCode: 1,
    });
  });

  it("runs exit handlers before the program is over", async () => {
    const result = await run('import atexit\natexit.register(print, "bye")\nprint("hi")\n');
    expect(result).toEqual({ status: "success", output: "hi\nbye\n" });
  });

  it("has no keyboard: input() meets the end of input, and the result says why", async () => {
    const result = await run('name = input("Name: ")\nprint(name)\n');
    expect(result.status).toBe("runtime-error");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Name: ");
    expect(result.output).toContain("EOFError: EOF when reading a line");
    expect(result.hint).toContain("input() has nothing to read");
  });

  it("leaves an EOFError the program raised by itself unexplained", async () => {
    const result = await run('raise EOFError("mine")\n');
    expect(result.exitCode).toBe(1);
    expect(result.hint).toBeUndefined();
  });

  it("names a module that is not in the lesson", async () => {
    const result = await run("import numpy\n");
    expect(result.output).toContain("ModuleNotFoundError: No module named 'numpy'");
    expect(result.hint).toContain("'numpy' is not here");
  });

  it("has the standard library, sqlite3 and asyncio included", async () => {
    const result = await run(
      [
        "import asyncio, sqlite3, json, statistics",
        "async def answer():",
        "    await asyncio.sleep(0.01)",
        '    return sqlite3.connect(":memory:").execute("select 6 * 7").fetchone()[0]',
        "print(json.dumps({'answer': asyncio.run(answer()), 'mean': statistics.mean([1, 2, 3])}))",
      ].join("\n"),
    );
    expect(result).toEqual({ status: "success", output: '{"answer": 42, "mean": 2}\n' });
  });

  it("stops a program that prints without end, at its last whole line", async () => {
    const result = await run('while True:\n    print("spam and eggs")\n');
    expect(result.status).toBe("runtime-error");
    expect(result.exitDetail).toBe(PYTHON_OUTPUT_LIMIT_DETAIL);
    expect(result.exitCode).toBeUndefined();
    expect(result.output.length).toBeLessThanOrEqual(PYTHON_MAX_OUTPUT_BYTES);
    expect(result.output.length).toBeGreaterThan(PYTHON_MAX_OUTPUT_BYTES - 32);
    expect(result.output.endsWith("spam and eggs\n")).toBe(true);
    expect(result.output).not.toContain("KeyboardInterrupt");
  });

  it("stops a loop that never ends, and keeps what it printed first", async () => {
    const startedAt = performance.now();
    const result = await run('print("started")\nwhile True:\n    pass\n');
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(result.status).toBe("runtime-error");
    // What Python prints about the interrupt that ended it is not output.
    expect(result).toEqual({
      status: "runtime-error",
      output: "started\n",
      exitDetail: PYTHON_TIME_LIMIT_DETAIL,
    });
  });

  it("stops a loop that swallows the interrupt as well", async () => {
    const result = await run(
      "while True:\n    try:\n        pass\n    except KeyboardInterrupt:\n        pass\n",
    );
    expect(result.exitDetail).toBe(PYTHON_TIME_LIMIT_DETAIL);
  });

  it("answers only with results the contract accepts", async () => {
    for (const source of ['print("ok")\n', "1 / 0\n", "import sys\nsys.exit(2)\n"]) {
      const result = await run(source);
      expect(parsePythonPlaygroundRunResult(result)).toEqual(result);
    }
  });
});
