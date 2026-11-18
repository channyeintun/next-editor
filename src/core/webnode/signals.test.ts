// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  endsByDefault,
  exitStatusNumber,
  SIGNAL_NUMBERS,
  signalExitStatus,
  signalName,
  signalNumber,
} from "./signals";

describe("signal default actions", () => {
  it("ends a process on a terminating signal, and on nothing ignored or stopping", () => {
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM", "SIGKILL", "SIGPIPE", "SIGUSR1"]) {
      expect(endsByDefault(signal)).toBe(true);
    }
    for (const signal of ["SIGCHLD", "SIGCONT", "SIGURG", "SIGWINCH"]) {
      expect(endsByDefault(signal)).toBe(false);
    }
    // Stopping is not supported: a stop signal's default action does nothing.
    for (const signal of ["SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU"]) {
      expect(endsByDefault(signal)).toBe(false);
    }
  });

  it("numbers signals as Linux does", () => {
    expect(SIGNAL_NUMBERS.SIGINT).toBe(2);
    expect(SIGNAL_NUMBERS.SIGTTIN).toBe(21);
    expect(SIGNAL_NUMBERS.SIGURG).toBe(23);
    expect(SIGNAL_NUMBERS.SIGWINCH).toBe(28);
  });

  it("knows a signal by its name or its number, and nothing an object merely has", () => {
    expect([signalNumber("SIGTERM"), signalNumber("SIGXCPU"), signalNumber("TERM")]).toEqual([
      15,
      24,
      undefined,
    ]);
    expect([signalNumber("constructor"), signalNumber("toString")]).toEqual([undefined, undefined]);
    expect([signalName(9), signalName(31), signalName(0), signalName(64)]).toEqual([
      "SIGKILL",
      "SIGSYS",
      undefined,
      undefined,
    ]);
  });
});

describe("the exit status of a process a signal ended", () => {
  it("is 128 + the signal's Linux number, as a shell's $? is", () => {
    // bash on this Mac: `sh -c 'kill -XCPU $$'; echo $?` gives 152, -VTALRM
    // 154, -INT 130, -TERM 143 (these numbers are the same on Linux).
    expect(
      ["SIGINT", "SIGTERM", "SIGKILL", "SIGXCPU", "SIGVTALRM", "SIGPIPE"].map(signalExitStatus),
    ).toEqual([130, 143, 137, 152, 154, 141]);
  });

  it("makes one number of an exit status: the code, or the signal's status", () => {
    expect(exitStatusNumber({ code: 3, signal: null })).toBe(3);
    expect(exitStatusNumber({ code: 0, signal: null })).toBe(0);
    expect(exitStatusNumber({ code: null, signal: "SIGTERM" })).toBe(143);
    expect(exitStatusNumber({ code: null, signal: "SIGHUP" })).toBe(129);
  });
});
