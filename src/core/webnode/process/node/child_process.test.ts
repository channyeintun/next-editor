// @vitest-environment node
// child_process over the fake runtime: a spawn that cannot start reports
// 'error' and then 'close' with the negative errno, as Node does.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemError } from "../../errors";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { fork, spawn } from "./child_process";

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

describe("spawn", () => {
  it("emits 'error' then 'close' with -2 when the command does not exist", async () => {
    fake.processes.spawn = () => {
      throw createSystemError("ENOENT", "spawn missing", "missing");
    };
    const child = spawn("missing", ["a"]);
    const events: unknown[][] = [];
    child.on("error", (error: { code?: string }) => events.push(["error", error.code]));
    child.on("close", (code: unknown, signal: unknown) => events.push(["close", code, signal]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual([
      ["error", "ENOENT"],
      ["close", -2, null],
    ]);
    expect(child.exitCode).toBe(-2);
    expect(fake.refCount).toBe(0);
  });
});

describe("fork", () => {
  it("leaves out the parent's -e/-p code, as Node does, but keeps its other options", () => {
    const requests: { command: string; args: string[] }[] = [];
    fake.processes.spawn = (request) => {
      requests.push(request);
      throw createSystemError("ENOENT", "spawn node", "node");
    };
    const code = 'require("child_process").fork("c.js", ["a"])';
    fake.execArgv = ["--conditions", "dev", "-e", code];
    fork("c.js", ["a"]).on("error", () => {});
    fake.execArgv = ["--print=1", "-r", "./pre.js", "-p", code];
    fork("c.js").on("error", () => {});
    // execArgv given by the caller is used as it is.
    fork("c.js", { execArgv: ["-e", "1"] }).on("error", () => {});
    expect(requests.map((request) => [request.command, ...request.args])).toEqual([
      ["node", "--conditions", "dev", "c.js", "a"],
      ["node", "-r", "./pre.js", "c.js"],
      ["node", "-e", "1", "c.js"],
    ]);
  });
});
