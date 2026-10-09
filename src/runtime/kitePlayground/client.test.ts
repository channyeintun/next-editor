import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { KitePlaygroundClient, type KiteEngine, type KiteEngineSource } from "./client";
import { instantiateKiteCompiler, type KiteCompiler } from "./compiler";
import { kiteRunResultToConsoleLines } from "./console";
import { runKiteSource } from "./operations";
import { parseKitePlaygroundRunResult, type KitePlaygroundRunResult } from "./types";

// Vitest cannot import a bare `.wasm`, so the compiler is instantiated from
// bytes — the same arrangement `src/core/dmp/dmpCodec.test.ts` uses.
const wasmPath = resolve(process.cwd(), "src/core/kite/build/kite-compiler.wasm");

describe("kite compiler", () => {
  let kite: KiteCompiler;

  beforeAll(async () => {
    kite = await instantiateKiteCompiler(readFileSync(wasmPath));
  });

  it("runs a program and answers with what it printed", () => {
    expect(kite.run('fn main() {\n    io.print("hello from a lesson")\n}\n')).toBe(
      "hello from a lesson\n",
    );
  });

  it("answers with nothing when a program checks clean", () => {
    expect(kite.check("fn main() {\n    io.print(1)\n}\n")).toBe("");
  });

  it("renders a diagnostic the way a terminal does", () => {
    const out = kite.check('fn main() {\n    let x: int = "no"\n}\n');
    expect(out).toContain("error[E0200]");
    expect(out).toContain("expected `int`, found `str`");
  });

  it("lays a program out the one way", () => {
    expect(kite.format("fn f(a:int)->int{\nreturn a*2\n}\n")).toBe(
      "fn f(a: int) -> int {\n    return a * 2\n}\n",
    );
  });

  it("refuses to drop an error, which is the language's whole point", () => {
    // `risky()` on a line of its own would discard the error, and Kite rejects
    // that rather than letting a lesson teach it.
    const out = kite.check(
      'fn risky() -> error {\n    return errors.new("no")\n}\nfn main() {\n    risky()\n}\n',
    );
    expect(out).toContain("E0302");
  });

  it("keeps working across many calls, so a lesson can run repeatedly", () => {
    // The answer is copied out before the next allocation, because growing the
    // module's memory detaches every view onto the old buffer. If that were
    // wrong, a later run would return rubbish rather than fail loudly.
    for (let i = 0; i < 40; i += 1) {
      expect(kite.run(`fn main() {\n    io.print(${i})\n}\n`)).toBe(`${i}\n`);
    }
  });
});

describe("loadKiteCompiler", () => {
  const WASM = "../../core/kite/build/kite-compiler.wasm";

  afterEach(() => {
    vi.doUnmock(WASM);
    vi.resetModules();
  });

  // A transient chunk failure (offline, a stale tab after a deploy) used to stay
  // cached, so every later Run reported the compiler unavailable until a reload.
  it("forgets a failed load, so the next call tries again", async () => {
    vi.resetModules();
    vi.doMock(WASM, () => Promise.reject(new Error("gone")));
    const { loadKiteCompiler } = await import("./compiler");

    const first = loadKiteCompiler();
    // Vitest wraps a failing mock factory's error; the original is its cause.
    await expect(first).rejects.toMatchObject({ cause: new Error("gone") });

    const exports = (await WebAssembly.instantiate(readFileSync(wasmPath))).instance.exports;
    vi.doMock(WASM, () => ({ default: exports }));
    const second = loadKiteCompiler();
    expect(second).not.toBe(first);

    const compiler = await second;
    expect(compiler.check("fn main() {\n    io.print(1)\n}\n")).toBe("");
    await expect(loadKiteCompiler()).resolves.toBe(compiler);
  });
});

describe("KitePlaygroundClient", () => {
  const files = [{ path: "main.kite", content: "fn main() {}\n" }];
  const ok: KitePlaygroundRunResult = { status: "success", stdout: "hi\n", stderr: "" };
  const never = () => new Promise<never>(() => {});

  function fakeEngine(run: KiteEngine["run"]) {
    return {
      load: vi.fn<KiteEngine["load"]>(async () => {}),
      run: vi.fn<KiteEngine["run"]>(run),
      format: vi.fn<KiteEngine["format"]>(async (sources) =>
        sources.map((source) => `${source.trim()}\n`),
      ),
      terminate: vi.fn<KiteEngine["terminate"]>(),
    };
  }

  function engineSource(...engines: KiteEngine[]) {
    const queue = [...engines];
    return {
      acquire: vi.fn<KiteEngineSource["acquire"]>(() => {
        const engine = queue.shift();
        if (!engine) throw new Error("no engine left");
        return engine;
      }),
      release: vi.fn<KiteEngineSource["release"]>(),
    };
  }

  // A program that never returns used to hang the page, because the compiler
  // ran it in one synchronous call on the main thread that nothing could stop.
  it("terminates the engine of a run that never returns when disposed", async () => {
    const engine = fakeEngine(never);
    const engines = engineSource(engine);
    const client = new KitePlaygroundClient({ engines });

    const pending = client.run({ files });
    await vi.waitFor(() => expect(engine.run).toHaveBeenCalled());
    client.dispose();

    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    expect(engine.terminate).toHaveBeenCalledTimes(1);
    expect(engines.release).not.toHaveBeenCalled();
  });

  it("stops the run in flight when a newer one starts, on a fresh engine", async () => {
    const stuck = fakeEngine(never);
    const fresh = fakeEngine(async () => ok);
    const client = new KitePlaygroundClient({ engines: engineSource(stuck, fresh) });

    const first = client.run({ files });
    await vi.waitFor(() => expect(stuck.run).toHaveBeenCalled());
    const second = client.run({ files });

    await expect(first).rejects.toMatchObject({ kind: "aborted" });
    await expect(second).resolves.toEqual(ok);
    expect(stuck.terminate).toHaveBeenCalledTimes(1);
    expect(fresh.terminate).not.toHaveBeenCalled();
  });

  it("keeps an idle engine across runs, so the compiler loads once", async () => {
    const engine = fakeEngine(async () => ok);
    const engines = engineSource(engine);
    const client = new KitePlaygroundClient({ engines });

    await expect(client.run({ files })).resolves.toEqual(ok);
    await expect(client.run({ files })).resolves.toEqual(ok);
    expect(engines.acquire).toHaveBeenCalledTimes(1);
    expect(engine.terminate).not.toHaveBeenCalled();
  });

  it("hands an idle engine back on dispose rather than terminating it", async () => {
    const engine = fakeEngine(async () => ok);
    const engines = engineSource(engine);
    const client = new KitePlaygroundClient({ engines });

    await client.run({ files });
    client.dispose();
    expect(engines.release).toHaveBeenCalledWith(engine);
    expect(engine.terminate).not.toHaveBeenCalled();
  });

  it("reports a compiler that will not load as unavailable", async () => {
    const engine = fakeEngine(async () => ok);
    engine.load.mockRejectedValueOnce(new Error("chunk failed"));
    const client = new KitePlaygroundClient({ engines: engineSource(engine) });

    await expect(client.run({ files })).rejects.toMatchObject({
      kind: "unavailable",
      message: "The Kite compiler could not be loaded (chunk failed)",
    });
    expect(engine.run).not.toHaveBeenCalled();
    await expect(client.run({ files })).resolves.toEqual(ok);
  });

  it("formats every file through the engine, keeping each path", async () => {
    const engine = fakeEngine(async () => ok);
    const client = new KitePlaygroundClient({ engines: engineSource(engine) });

    await expect(
      client.format({
        files: [
          { path: "main.kite", content: "fn main() {}  " },
          { path: "shapes.kite", content: "fn area() {}  " },
        ],
      }),
    ).resolves.toEqual({
      files: [
        { path: "main.kite", content: "fn main() {}\n" },
        { path: "shapes.kite", content: "fn area() {}\n" },
      ],
    });
    expect(engine.format).toHaveBeenCalledWith(["fn main() {}  ", "fn area() {}  "]);
  });

  describe("without a Worker", () => {
    const WASM = "../../core/kite/build/kite-compiler.wasm";

    afterEach(() => {
      vi.doUnmock(WASM);
      vi.resetModules();
    });

    it("runs the compiler in this page", async () => {
      expect(typeof Worker).toBe("undefined");
      vi.resetModules();
      const exports = (await WebAssembly.instantiate(readFileSync(wasmPath))).instance.exports;
      vi.doMock(WASM, () => ({ default: exports }));
      const { KitePlaygroundClient: PageClient } = await import("./client");

      await expect(
        new PageClient().run({
          files: [{ path: "main.kite", content: 'fn main() {\n    io.print("in page")\n}\n' }],
        }),
      ).resolves.toEqual({ status: "success", stdout: "in page\n", stderr: "" });
    });
  });
});

describe("runKiteSource", () => {
  let kite: KiteCompiler;

  beforeAll(async () => {
    kite = await instantiateKiteCompiler(readFileSync(wasmPath));
  });

  it("reports a trap after the output the program printed before it", () => {
    const result = runKiteSource(
      kite,
      'fn main() {\n    io.print("before")\n    let a = 0\n    io.print(10 / a)\n}\n',
    );
    expect(result).toEqual({
      status: "runtime-error",
      stdout: "before\n",
      stderr: "",
      exitDetail: "divide by zero",
    });
    expect(kiteRunResultToConsoleLines(result)).toEqual([
      "before",
      "[kite-run error] divide by zero",
    ]);
  });

  it("reports a trap with no output before it", () => {
    const result = runKiteSource(
      kite,
      "fn main() {\n    let xs = [1, 2]\n    io.print(xs[5])\n}\n",
    );
    expect(result.status).toBe("runtime-error");
    expect(result.stdout).toBe("");
    expect(result.exitDetail).toContain("out of range");
  });

  it("leaves a program's own `error:` line as output", () => {
    // Kite teaches errors as values, so a correct program printing one is
    // ordinary output, not diagnostics.
    expect(
      runKiteSource(
        kite,
        'fn main() {\n    io.print("checking")\n    io.print("error: bad input")\n}\n',
      ),
    ).toEqual({ status: "success", stdout: "checking\nerror: bad input\n", stderr: "" });
  });

  it("leaves a program's own line starting with `trap` as output", () => {
    expect(runKiteSource(kite, 'fn main() {\n    io.print("trapezoid area: 12")\n}\n')).toEqual({
      status: "success",
      stdout: "trapezoid area: 12\n",
      stderr: "",
    });
  });

  it("reports a program that does not compile as a compile error", () => {
    const result = runKiteSource(kite, 'fn main() {\n    var x: int = "s"\n}\n');
    expect(result.status).toBe("compile-error");
    expect(result.stdout).toBe("");
    expect(result.compileErrors).toContain("error[E0200]");
  });
});

describe("run results become console lines", () => {
  it("shows program output and an exit line on success", () => {
    const result = parseKitePlaygroundRunResult({
      status: "success",
      stdout: "5\n",
      stderr: "",
    });
    expect(result).not.toBeNull();
    expect(kiteRunResultToConsoleLines(result!)).toEqual(["5", "[kite-run] Program exited"]);
  });

  it("shows the diagnostics as written when a build fails", () => {
    const result = parseKitePlaygroundRunResult({
      status: "compile-error",
      stdout: "",
      stderr: "",
      compileErrors: "error[E0200]: expected `int`, found `str`\n",
    });
    expect(result).not.toBeNull();
    expect(kiteRunResultToConsoleLines(result!)).toEqual([
      "[kite-run error] Build failed",
      "error[E0200]: expected `int`, found `str`",
    ]);
  });

  it("renders more output lines than a spread call can take", () => {
    // V8 caps a spread call near 125,000 arguments and the compiler sets no
    // output budget, so a long loop must still render rather than throw.
    const result = parseKitePlaygroundRunResult({
      status: "success",
      stdout: "x\n".repeat(200_000),
      stderr: "",
    });
    const lines = kiteRunResultToConsoleLines(result!);
    expect(lines).toHaveLength(200_001);
    expect(lines[199_999]).toBe("x");
    expect(lines[200_000]).toBe("[kite-run] Program exited");
  });

  it("says so when a program printed nothing", () => {
    const result = parseKitePlaygroundRunResult({ status: "success", stdout: "", stderr: "" });
    expect(kiteRunResultToConsoleLines(result!)).toEqual([
      "[kite-run] (no output)",
      "[kite-run] Program exited",
    ]);
  });

  it("rejects a status that disagrees with its own diagnostics", () => {
    // A success carrying compile errors is an impossible state, and rendering
    // it would show a green run over a failed build.
    expect(
      parseKitePlaygroundRunResult({
        status: "success",
        stdout: "",
        stderr: "",
        compileErrors: "error: something",
      }),
    ).toBeNull();
    expect(
      parseKitePlaygroundRunResult({ status: "compile-error", stdout: "", stderr: "" }),
    ).toBeNull();
  });
});
