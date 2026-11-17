// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../../kernel/vfs/types";
import { setRuntime } from "../../../runtime";
import { runShell } from "../index";
import { setupRuntime, sh } from "../testHelpers";
import { cut } from "./cut";
import { runFilter, settle } from "./filterTesting";
import { grep } from "./grep";
import { decodeText, encodeText } from "./lines";
import { tr } from "./tr";
import { uniq } from "./uniq";
import { xargs } from "./xargs";

afterEach(() => {
  setRuntime(null);
});

describe("filters write as their input arrives", () => {
  it("grep, tr, cut and uniq print a line before standard input ends", async () => {
    const cases = [
      { command: grep, args: ["ready"], expected: "server ready\n" },
      { command: tr, args: ["a-z", "A-Z"], expected: "SERVER READY\n" },
      { command: cut, args: ["-c1-6"], expected: "server\n" },
      { command: uniq, args: [], expected: "server ready\n" },
    ];
    for (const { command, args, expected } of cases) {
      const run = runFilter(command, args);
      run.feed("server ready\n");
      if (command === uniq) {
        // uniq knows a run ended when a different line arrives.
        run.feed("next\n");
      }
      await settle();
      expect(run.output()).toBe(expected);
      expect(run.finished()).toBe(false);
      run.feed(null);
      expect(await run.done).toBe(0);
    }
  });

  it("stop reading once their output is closed (`yes | grep y | head -1`)", async () => {
    for (const [command, args] of [
      [grep, ["y"]],
      [tr, ["y", "n"]],
      [cut, ["-c1"]],
      [uniq, ["-c"]],
    ] as const) {
      const run = runFilter(command, [...args]);
      run.feed("y\n");
      await settle();
      run.closeOutput();
      run.feed("y\nz\n");
      await settle();
      expect(run.finished()).toBe(true);
    }
  });

  it("xargs runs each full batch before its input ends", async () => {
    const ran: string[][] = [];
    const run = runFilter(xargs, ["-n1", "echo"], async (argv) => {
      ran.push(argv);
      return 0;
    });
    run.feed("a b\n");
    await settle();
    expect(ran).toEqual([
      ["echo", "a"],
      ["echo", "b"],
    ]);
    run.feed(null);
    expect(await run.done).toBe(0);
  });
});

describe("xargs", () => {
  it("-L N runs one command per N lines", async () => {
    expect((await sh("printf 'a b\\nc d\\n' | xargs -L 1 echo X")).out).toBe("X a b\nX c d\n");
    expect((await sh("printf 'a\\nb\\nc\\n' | xargs -L2 echo X")).out).toBe("X a b\nX c\n");
  });

  it("accepts -P4, -L1 and -s N written as one word or two", async () => {
    const result = await sh(
      "echo a b | xargs -P4 -n1 echo; echo a | xargs -P 0 -s 100 echo; echo $?",
    );
    expect(result.out).toBe("a\nb\na\n0\n");
    const bad = await sh("echo a | xargs -n x echo");
    expect(bad.err).toBe('xargs: invalid number "x" for -n option\n');
    expect(bad.status).toBe(1);
  });

  it("keeps running a command once on empty input, and not with -r", async () => {
    expect((await sh("printf '' | xargs echo X; printf '' | xargs -r echo Y")).out).toBe("X\n");
  });
});

describe("bytes that are not UTF-8", () => {
  it("decodeText and encodeText give every byte back", () => {
    const bytes = new Uint8Array([
      0x61, 0xff, 0xc3, 0xa9, 0xe2, 0x82, 0xed, 0xa0, 0x80, 0xf0, 0x9f, 0x98, 0x80, 0x0a,
    ]);
    const text = decodeText(bytes);
    expect(text.startsWith("a")).toBe(true);
    expect(text).toContain("é");
    expect(text).toContain("😀");
    expect(Array.from(encodeText(text))).toEqual(Array.from(bytes));
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("﻿a");
  });

  it("tr, cut and sort pass bytes they do not change through", async () => {
    const { rt, vfs } = setupRuntime({});
    vfs.writeFile(
      "/work/bin",
      new Uint8Array([0x61, 0xff, 0x62, 0x0a]),
      O_WRONLY | O_CREAT | O_TRUNC,
      0o644,
    );
    rt.feedStdin(null);
    await runShell(["sh", "-c", "tr a c < bin > t; cut -c1-3 bin > c; sort bin > s"]);
    expect(Array.from(vfs.readFile("/work/t"))).toEqual([0x63, 0xff, 0x62, 0x0a]);
    expect(Array.from(vfs.readFile("/work/c"))).toEqual([0x61, 0xff, 0x62, 0x0a]);
    expect(Array.from(vfs.readFile("/work/s"))).toEqual([0x61, 0xff, 0x62, 0x0a]);
  });
});
