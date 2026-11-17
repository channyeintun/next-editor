// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../../kernel/vfs/types";
import { setRuntime } from "../../../runtime";
import { runShell } from "../index";
import { readText, setupRuntime, sh } from "../testHelpers";
import { runFilter, settle } from "./filterTesting";
import { sed } from "./sed";

afterEach(() => {
  setRuntime(null);
});

const files = { "/work/a.txt": "alpha\nbeta\ngamma\n" };

describe("sed options", () => {
  it("accepts combined short options: -ne, -Ei, -nf", async () => {
    const ne = await sh("sed -ne '2p' a.txt; sed -ne 's/a$/A/p' a.txt", { files });
    expect(ne.out).toBe("beta\nalphA\nbetA\ngammA\n");
    expect(ne.status).toBe(0);
    const ei = await sh("sed -Ei 's/(a)l/[\\1]/' a.txt; cat a.txt", { files });
    expect(ei.out).toBe("[a]pha\nbeta\ngamma\n");
    const nf = await sh("echo 2p > s.sed; sed -nf s.sed a.txt", { files });
    expect(nf.out).toBe("beta\n");
    const bad = await sh("sed -nZ p a.txt", { files });
    expect(bad.err).toBe("sed: invalid option -- 'Z'\n");
    expect(bad.status).toBe(1);
  });
});

describe("sed s///", () => {
  it("an empty regex reuses the last one", async () => {
    expect((await sh("echo foo bar | sed '/foo/s//X/'")).out).toBe("X bar\n");
    expect((await sh("echo foo | sed 's//X/'")).err).toContain("no previous regular expression");
  });

  it("an empty match right after a match is not replaced", async () => {
    expect((await sh("echo baaac | sed 's/a*/x/g'")).out).toBe("xbxcx\n");
    expect((await sh("echo abc | sed 's/x*/-/g'")).out).toBe("-a-b-c-\n");
  });
});

describe("sed keeps bytes", () => {
  it("-i.bak backs up the original bytes and keeps bytes that are not UTF-8", async () => {
    const { rt, vfs } = setupRuntime({});
    vfs.writeFile(
      "/work/bin",
      new Uint8Array([0x61, 0xff, 0x62, 0x0a]),
      O_WRONLY | O_CREAT | O_TRUNC,
      0o644,
    );
    rt.feedStdin(null);
    await runShell(["sh", "-c", "sed -i.bak 's/a/c/' bin"]);
    expect(Array.from(vfs.readFile("/work/bin.bak"))).toEqual([0x61, 0xff, 0x62, 0x0a]);
    expect(Array.from(vfs.readFile("/work/bin"))).toEqual([0x63, 0xff, 0x62, 0x0a]);
  });

  it("keeps a missing final newline missing, and only there", async () => {
    expect((await sh("printf 'a\\nb' | sed s/b/B/")).out).toBe("a\nB");
    expect((await sh("printf 'a\\nb' | sed '$d'")).out).toBe("a\n");
    expect((await sh("printf 'a\\nb' | sed 'a X'")).out).toBe("a\nX\nb\nX");
    const inPlace = await sh("printf 'x\\ny' > f; sed -i s/y/Y/ f", {});
    expect(readText(inPlace.vfs, "/work/f")).toBe("x\nY");
  });
});

describe("sed streams", () => {
  it("writes each line as it arrives", async () => {
    const run = runFilter(sed, ["s/ready/READY/"]);
    run.feed("server ready\n");
    await settle();
    expect(run.output()).toBe("server READY\n");
    run.feed("more\n");
    run.feed(null);
    expect(await run.done).toBe(0);
    expect(run.output()).toBe("server READY\nmore\n");
  });

  it("holds one line back only for $", async () => {
    const run = runFilter(sed, ["$s/$/ (last)/"]);
    run.feed("one\ntwo\n");
    await settle();
    expect(run.output()).toBe("one\n");
    run.feed(null);
    await run.done;
    expect(run.output()).toBe("one\ntwo (last)\n");
  });

  it("n, q and line numbers across arrivals", async () => {
    const run = runFilter(sed, ["-n", "n;p;4q"]);
    run.feed("1\n2\n");
    await settle();
    expect(run.output()).toBe("2\n");
    run.feed("3\n4\n");
    expect(await run.done).toBe(0);
    expect(run.output()).toBe("2\n4\n");
    expect(run.finished()).toBe(true);
  });

  it("stops reading once its output is closed", async () => {
    const run = runFilter(sed, ["p"]);
    run.feed("y\n");
    await settle();
    run.closeOutput();
    run.feed("y\n");
    await settle();
    expect(run.finished()).toBe(true);
  });
});
