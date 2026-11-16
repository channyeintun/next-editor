// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../kernel/vfs/types";
import { setRuntime } from "../runtime";
import { createFakeRuntime } from "../testing/fakeRuntime";
import type { FakeRuntime } from "../testing/fakeRuntime";
import wasi, { WASI } from "./wasi";

const encoder = new TextEncoder();

/** A module that writes "hi\n" to stdout through fd_write and returns. */
const HELLO = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x0c, 0x02, 0x60, 0x04, 0x7f, 0x7f, 0x7f,
  0x7f, 0x01, 0x7f, 0x60, 0x00, 0x00, 0x02, 0x23, 0x01, 0x16, 0x77, 0x61, 0x73, 0x69, 0x5f, 0x73,
  0x6e, 0x61, 0x70, 0x73, 0x68, 0x6f, 0x74, 0x5f, 0x70, 0x72, 0x65, 0x76, 0x69, 0x65, 0x77, 0x31,
  0x08, 0x66, 0x64, 0x5f, 0x77, 0x72, 0x69, 0x74, 0x65, 0x00, 0x00, 0x03, 0x02, 0x01, 0x01, 0x05,
  0x03, 0x01, 0x00, 0x01, 0x07, 0x13, 0x02, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
  0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x01, 0x0a, 0x0f, 0x01, 0x0d, 0x00, 0x41, 0x01,
  0x41, 0x10, 0x41, 0x01, 0x41, 0x30, 0x10, 0x00, 0x1a, 0x0b, 0x0b, 0x16, 0x02, 0x00, 0x41, 0x10,
  0x0b, 0x08, 0x20, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x41, 0x20, 0x0b, 0x03, 0x68,
  0x69, 0x0a,
]);

describe("wasi", () => {
  let fake: FakeRuntime;

  beforeEach(() => {
    fake = createFakeRuntime({ cwd: "/work" });
    fake.vfs.mkdir("/work", true, 0o755);
    fake.fs.writeFile(
      "/work/data.txt",
      encoder.encode("hello"),
      O_WRONLY | O_CREAT | O_TRUNC,
      0o644,
    );
    setRuntime(fake);
  });

  afterEach(() => {
    setRuntime(null);
  });

  it("exports the WASI class", () => {
    expect(wasi.WASI).toBe(WASI);
  });

  it("requires a version, as Node does", () => {
    expect(() => new WASI({})).toThrow(/options\.version/);
    expect(() => new WASI({ version: "preview2" })).toThrow(/options\.version/);
  });

  it("offers the preview1 system calls a module imports", () => {
    const instance = new WASI({ version: "preview1", preopens: { "/": "/" } });
    const imports = instance.getImportObject();
    expect(Object.keys(imports)).toEqual(["wasi_snapshot_preview1"]);
    for (const name of ["fd_write", "fd_read", "path_open", "fd_close", "clock_time_get"]) {
      expect(typeof imports.wasi_snapshot_preview1[name]).toBe("function");
    }
  });

  it("runs a module whose output goes to the process's stdout", async () => {
    const instance = new WASI({ version: "preview1", args: ["hello"], env: {} });
    const module = await WebAssembly.compile(HELLO);
    const wasm = await WebAssembly.instantiate(module, instance.getImportObject());
    expect(instance.start(wasm)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.stdout()).toContain("hi");
  });
});
