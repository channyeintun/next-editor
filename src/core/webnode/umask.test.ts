// @vitest-environment node
// A process's file mode creation mask as the kernel, the process and its
// threads share it: one word of memory, holding permission bits only.
import { describe, expect, it } from "vitest";
import { createUmaskCell, DEFAULT_UMASK, readUmask, umaskBits, writeUmask } from "./umask";

describe("a process's mask", () => {
  it("starts as given, and is set by a write that returns the mask before it", () => {
    expect(DEFAULT_UMASK).toBe(0o022);
    const cell = createUmaskCell(DEFAULT_UMASK);
    expect(readUmask(cell)).toBe(0o022);
    expect(writeUmask(cell, 0o077)).toBe(0o022);
    expect(writeUmask(cell, 0)).toBe(0o077);
    expect(readUmask(cell)).toBe(0);
  });

  it("keeps the permission bits of what it is set to, as umask(2) on Linux", () => {
    expect([0o7777, 0o1022, -1, 2 ** 32 + 0o027, 1.9].map(umaskBits)).toEqual([
      0o777, 0o022, 0o777, 0o027, 1,
    ]);
    const cell = createUmaskCell(0o4027);
    expect(readUmask(cell)).toBe(0o027);
    expect(writeUmask(cell, 0o7002)).toBe(0o027);
    expect(readUmask(cell)).toBe(0o002);
    // A word something else wrote more into still reads as a mask.
    Atomics.store(cell, 0, 0o170077);
    expect(readUmask(cell)).toBe(0o077);
  });

  it("is one word of shared memory: another view of it, as another worker has, is the same mask", () => {
    const cell = createUmaskCell(0o022);
    expect(cell.buffer).toBeInstanceOf(SharedArrayBuffer);
    const elsewhere = new Int32Array(cell.buffer);
    writeUmask(elsewhere, 0o077);
    expect(readUmask(cell)).toBe(0o077);
    // Each process has a word of its own.
    const other = createUmaskCell(readUmask(cell));
    writeUmask(other, 0);
    expect([readUmask(cell), readUmask(other)]).toEqual([0o077, 0]);
  });
});
