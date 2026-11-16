// @vitest-environment node
// readline/promises: question as a promise (with abort), createInterface, and
// the Readline action queue compared with real Node's.
import * as nodePromises from "node:readline/promises";
import { Writable as NodeWritable } from "node:stream";
import { describe, expect, it } from "vitest";
import readline from "./readline";
import promises, { createInterface, Interface, Readline } from "./readline_promises";
import { PassThrough } from "./stream";

function capture() {
  return {
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

describe("readline/promises", () => {
  it("is readline.promises", () => {
    expect(readline.promises).toBe(promises);
    expect(promises.Interface).toBe(Interface);
    expect(promises.Readline).toBe(Readline);
    expect(promises.createInterface).toBe(createInterface);
  });

  it("resolves question with the answer", async () => {
    const input = new PassThrough();
    const output = capture();
    const rl = createInterface({ input, output, terminal: false });
    expect(rl).toBeInstanceOf(Interface);
    const answer = rl.question("Name? ");
    expect(output.data).toBe("Name? ");
    input.write("Ada\n");
    expect(await answer).toBe("Ada");
    rl.close();
    await expect(rl.question("again")).rejects.toMatchObject({ code: "ERR_USE_AFTER_CLOSE" });
  });

  it("rejects with AbortError on abort", async () => {
    const input = new PassThrough();
    const rl = createInterface({ input, terminal: false });
    const controller = new AbortController();
    const answer = rl.question("? ", { signal: controller.signal });
    controller.abort();
    await expect(answer).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    await expect(rl.question("? ", { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: "ABORT_ERR",
    });
    const lines: string[] = [];
    rl.on("line", (line: string) => lines.push(line));
    input.write("free\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toEqual(["free"]);
    rl.close();
  });

  it("iterates lines", async () => {
    const input = new PassThrough();
    const rl = createInterface({ input });
    setTimeout(() => input.end("a\nb"), 1);
    const seen: string[] = [];
    for await (const line of rl) {
      seen.push(line);
    }
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("Readline", () => {
  it("queues actions and writes them on commit, as Node does", async () => {
    const run = async (Impl: typeof Readline) => {
      // Node accepts only a real Writable, so both get one.
      const out = { data: "" };
      const sink = new NodeWritable({
        write(chunk: Buffer, _encoding, callback) {
          out.data += chunk.toString();
          callback();
        },
      });
      const r = new Impl(sink);
      r.cursorTo(2).cursorTo(1, 4).moveCursor(3, -1).moveCursor(0, 0).clearLine(-1);
      r.clearLine(0).clearLine(1).clearScreenDown();
      const before = out.data;
      await r.commit();
      const committed = out.data;
      r.cursorTo(0).rollback();
      await r.commit();
      return [before, committed, out.data];
    };
    expect(await run(Readline)).toEqual(
      await run(nodePromises.Readline as unknown as typeof Readline),
    );
  });

  it("writes at once with autoCommit", async () => {
    const out = capture();
    new Readline(out, { autoCommit: true }).cursorTo(0);
    expect(out.data).toBe("");
    await Promise.resolve();
    expect(out.data).toBe("\x1b[1G");
  });

  it("validates like Node", () => {
    expect(() => new Readline({})).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => new Readline(capture(), { autoCommit: 1 as never })).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    const r = new Readline(capture());
    expect(() => r.cursorTo(1.5)).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
    expect(() => r.clearLine(2)).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
    expect(() => r.moveCursor("1" as never, 0)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });
});
