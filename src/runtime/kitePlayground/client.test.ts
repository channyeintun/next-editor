import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { instantiateKiteCompiler, type KiteCompiler } from "./compiler";
import { kiteRunResultToConsoleLines } from "./console";
import { parseKitePlaygroundRunResult } from "./types";

// Vitest cannot import a bare `.wasm`, so the compiler is instantiated from
// bytes — the same arrangement `dmpCodec.test.ts` uses.
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
