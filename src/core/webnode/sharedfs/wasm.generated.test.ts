// @vitest-environment node
// The committed module (wasm.generated.ts) is built by hand, with
// `bun run build:webnode-fs`; nothing rebuilds it in a deploy. These tests fail
// when it no longer matches the source it is said to be built from, and when
// the two statements of the contract (abi.rs, abi.ts) disagree.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ARGS_CAPACITY, ERRNO_CODES, OFFSET, PROCESS_SLOTS, SYSCALL_NAMES } from "./abi";
import {
  SHARED_FS_DATA_SEGMENTS,
  SHARED_FS_MEMORY,
  SHARED_FS_SOURCE_FILES,
  SHARED_FS_SOURCE_HASH,
  SHARED_FS_WASM_BASE64,
} from "./wasm.generated";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Every Rust file under `directory`, relative to this directory. */
function rustFiles(directory: string): string[] {
  return readdirSync(here(directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return rustFiles(path);
    }
    return entry.name.endsWith(".rs") ? [path] : [];
  });
}

describe("the committed filesystem module", () => {
  it("was built from the Rust source as it is now", () => {
    // Fails after an edit to the crate without `bun run build:webnode-fs`.
    const hash = createHash("sha256");
    for (const file of SHARED_FS_SOURCE_FILES) {
      hash.update(file);
      hash.update("\0");
      hash.update(readFileSync(here(file)));
      hash.update("\0");
    }
    expect(hash.digest("hex")).toBe(SHARED_FS_SOURCE_HASH);
  });

  it("was built from every Rust file of the crate", () => {
    const built = SHARED_FS_SOURCE_FILES.filter((file) => file.endsWith(".rs"));
    expect(rustFiles("crate/src").sort()).toEqual([...built].sort());
  });

  it("is a module every instance can share: no start function, no data, a shared memory", () => {
    const module = new WebAssembly.Module(Buffer.from(SHARED_FS_WASM_BASE64, "base64"));
    expect(
      WebAssembly.Module.imports(module)
        .map((entry) => `${entry.module}.${entry.name}:${entry.kind}`)
        .sort(),
    ).toEqual(["env.memory:memory", "env.now:function"]);
    // A start function or a data section would reset the statics for everyone
    // each time a worker instantiated the module (scripts/build-webnode-fs-wasm.mjs).
    const sectionIds: number[] = [];
    const bytes = Buffer.from(SHARED_FS_WASM_BASE64, "base64");
    for (let at = 8; at < bytes.length;) {
      sectionIds.push(bytes[at]);
      let size = 0;
      let shift = 0;
      let index = at + 1;
      for (;;) {
        const byte = bytes[index++];
        size += (byte & 0x7f) * 2 ** shift;
        shift += 7;
        if ((byte & 0x80) === 0) {
          break;
        }
      }
      at = index + size;
    }
    expect(sectionIds).not.toContain(8);
    expect(sectionIds).not.toContain(11);
    expect(sectionIds).not.toContain(12);
    // Instantiating on an unshared memory must be refused: the import is shared.
    const unshared = new WebAssembly.Memory({ initial: SHARED_FS_MEMORY.initial, maximum: 256 });
    expect(
      () => new WebAssembly.Instance(module, { env: { memory: unshared, now: () => 0 } }),
    ).toThrow(WebAssembly.LinkError);
  });
});

describe("what the module carries into a public script", () => {
  it("names no path of the machine it was built on", () => {
    const parts = [
      Buffer.from(SHARED_FS_WASM_BASE64, "base64"),
      ...SHARED_FS_DATA_SEGMENTS.map(([, data]) => Buffer.from(data, "base64")),
    ];
    for (const part of parts) {
      const text = part.toString("latin1");
      expect(text).not.toMatch(/\/(?:Users|home)\/[^\0/]+\//);
      expect(text).not.toMatch(/[A-Za-z]:\\Users\\/);
    }
  });
});

describe("the contract in Rust and in TypeScript", () => {
  const rust = readFileSync(here("crate/src/abi.rs"), "utf8");
  const constant = (name: string) =>
    Number(new RegExp(`pub const ${name}: usize = (\\d+);`).exec(rust)?.[1]);
  /** `Name = number` pairs of the Rust enum `name`, in order. */
  const variants = (name: string) => {
    const body = new RegExp(`pub enum ${name} \\{([^}]*)\\}`).exec(rust)?.[1] ?? "";
    return [...body.matchAll(/(\w+) = (\d+),/g)].map((match) => [match[1], Number(match[2])]);
  };

  it("agrees on the sizes", () => {
    expect(constant("ARGS_CAPACITY")).toBe(ARGS_CAPACITY);
    expect(constant("PROCESS_SLOTS")).toBe(PROCESS_SLOTS);
  });

  it("agrees on where each field of the shared block is", () => {
    const stated = /Offsets \(bytes\): ([^.]*)\./.exec(rust.replace(/\n\s*\/\/\/ ?/g, " "))?.[1];
    const offsets = Object.fromEntries(
      (stated ?? "").split(",").map((pair) => {
        const [name, value] = pair.trim().split(" ");
        return [name, Number(value)];
      }),
    );
    expect(offsets).toEqual({
      lock: OFFSET.lock,
      poisoned: OFFSET.poisoned,
      watching: OFFSET.watching,
      events_len: OFFSET.eventsLength,
      slots: OFFSET.slots,
      errno: OFFSET.errno,
      syscall: OFFSET.syscall,
      path_mode: OFFSET.pathMode,
      ptr: OFFSET.ptr,
      len: OFFSET.len,
      aux: OFFSET.aux,
      events_dropped: OFFSET.eventsDropped,
      privileged: OFFSET.privileged,
      umask: OFFSET.umask,
      stat: OFFSET.stat,
      args: OFFSET.args,
    });
    // The slots end where the result begins.
    expect(OFFSET.slots + PROCESS_SLOTS * 4).toBe(OFFSET.errno);
  });

  it("agrees on the error codes, by number", () => {
    const codes = variants("Errno");
    expect(codes.length).toBe(ERRNO_CODES.length - 1);
    for (const [name, number] of codes) {
      expect(ERRNO_CODES[number as number]).toBe(String(name).toUpperCase());
    }
  });

  it("agrees on the system call names, by number", () => {
    const calls = variants("Syscall");
    expect(calls.length).toBe(SYSCALL_NAMES.length - 1);
    for (const [name, number] of calls) {
      expect(SYSCALL_NAMES[number as number]).toBe(String(name).toLowerCase());
    }
  });
});
