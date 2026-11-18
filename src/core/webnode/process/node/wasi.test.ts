// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  /** HELLO with its three output bytes replaced. */
  function writing(bytes: [number, number, number]): Uint8Array<ArrayBuffer> {
    return new Uint8Array([...HELLO.subarray(0, HELLO.length - 3), ...bytes]);
  }

  async function run(module: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const written: Uint8Array[] = [];
    const write = fake.fdStream.write.bind(fake.fdStream);
    vi.spyOn(fake.fdStream, "write").mockImplementation((fd, chunk, done) => {
      if (fd === 1) {
        written.push(chunk);
      }
      write(fd, chunk, done);
    });
    const instance = new WASI({ version: "preview1", args: [], env: {} });
    const wasm = await WebAssembly.instantiate(
      await WebAssembly.compile(module),
      instance.getImportObject(),
    );
    expect(instance.start(wasm)).toBe(0);
    return new Uint8Array(written.flatMap((chunk) => [...chunk]));
  }

  it("writes stdout without waiting for a newline", async () => {
    expect([...(await run(writing([0x68, 0x69, 0x21])))]).toEqual([0x68, 0x69, 0x21]);
    expect(fake.stdout()).toBe("hi!");
  });

  it("writes stdout bytes that are not UTF-8 unchanged", async () => {
    expect([...(await run(writing([0xff, 0xfe, 0x0a])))]).toEqual([0xff, 0xfe, 0x0a]);
  });

  it("returns EPIPE to the module when stdout's reader has gone, as uvwasi does", () => {
    fake.closeReader(1);
    const instance = new WASI({ version: "preview1", args: [], env: {} });
    const memory = new WebAssembly.Memory({ initial: 1 });
    instance.initialize({ exports: { memory } } as unknown as WebAssembly.Instance);
    const view = new DataView(memory.buffer);
    // One iovec at 8: 3 bytes at 64; the count goes to 16.
    view.setUint32(8, 64, true);
    view.setUint32(12, 3, true);
    const fdWrite = instance.getImportObject().wasi_snapshot_preview1.fd_write as (
      ...args: number[]
    ) => number;
    expect(fdWrite(1, 8, 1, 16)).toBe(64);
  });

  it("reads stdin from the process's fd 0", () => {
    const instance = new WASI({ version: "preview1", args: [], env: {} });
    const memory = new WebAssembly.Memory({ initial: 1 });
    instance.initialize({ exports: { memory } } as unknown as WebAssembly.Instance);
    const view = new DataView(memory.buffer);
    // One iovec at 8: 8 bytes at 64; the count goes to 16.
    view.setUint32(8, 64, true);
    view.setUint32(12, 8, true);
    const fdRead = instance.getImportObject().wasi_snapshot_preview1.fd_read as (
      ...args: number[]
    ) => number;
    expect(fdRead(0, 8, 1, 16)).toBe(6); // EAGAIN: nothing fed yet
    fake.feedStdin("abc");
    expect(fdRead(0, 8, 1, 16)).toBe(0);
    expect(view.getUint32(16, true)).toBe(3);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, 64, 3))).toBe("abc");
    fake.feedStdin(null);
    expect(fdRead(0, 8, 1, 16)).toBe(0);
    expect(view.getUint32(16, true)).toBe(0);
  });
});
