// @vitest-environment node
// The error of a failed system call, against the one the host's real Node
// raises: its message and its properties, in Node's order (what a program
// that prints the error sees).
import * as nodeFs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createSystemError,
  errnoCodeOf,
  systemErrorFromRecord,
  toSystemErrorRecord,
} from "./errors";

function thrownBy(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
}

describe("a system error", () => {
  it("has Node's message and Node's properties, in Node's order", () => {
    const real = thrownBy(() => nodeFs.readFileSync("/no/such/file"));
    const ours = createSystemError("ENOENT", "open", "/no/such/file");
    expect(ours.message).toBe(real.message);
    expect(Object.entries(ours)).toEqual(Object.entries(real));
    // errno first, then code, syscall, path and dest.
    const renamed = thrownBy(() => nodeFs.renameSync("/no/such/file", "/no/such/other"));
    const ourRename = createSystemError("ENOENT", "rename", "/no/such/file", "/no/such/other");
    expect(ourRename.message).toBe(renamed.message);
    expect(Object.entries(ourRename)).toEqual(Object.entries(renamed));
  });

  it("is the same error after it crossed a thread as a record", () => {
    const error = createSystemError("EACCES", "open", "/x");
    const record = toSystemErrorRecord(error);
    expect(record).toEqual({
      code: "EACCES",
      syscall: "open",
      path: "/x",
      dest: undefined,
      address: undefined,
      port: undefined,
    });
    const rebuilt = systemErrorFromRecord(record!);
    expect([rebuilt.message, Object.entries(rebuilt)]).toEqual([
      error.message,
      Object.entries(error),
    ]);
  });

  it("gives its errno code, and none for an error that is no failed system call", () => {
    expect(errnoCodeOf(createSystemError("ENOTEMPTY", "rmdir", "/d"))).toBe("ENOTEMPTY");
    expect(errnoCodeOf(new Error("plain"))).toBeUndefined();
    expect(
      errnoCodeOf(Object.assign(new Error("coded"), { code: "ERR_INVALID_ARG_TYPE" })),
    ).toBeUndefined();
    // A code alone does not make a system call's error, nor does a name every object has.
    expect(errnoCodeOf(Object.assign(new Error("no call"), { code: "ENOENT" }))).toBeUndefined();
    expect(
      errnoCodeOf(Object.assign(new Error("odd"), { code: "constructor", syscall: "x" })),
    ).toBe(undefined);
    expect(errnoCodeOf("ENOENT")).toBeUndefined();
    expect(errnoCodeOf(null)).toBeUndefined();
  });
});
