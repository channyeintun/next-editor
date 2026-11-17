// Signal names and numbers, and how a child's exit becomes a shell status
// (the code, or 128 + the signal number).
import { runtime } from "../../runtime";
import type { ExitStatus, ProcessBackend } from "../../runtime";

const SIGNALS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGWINCH: 28,
};

/** The number of a signal name (`SIGINT` or `INT`), or undefined. */
export function signalNumber(name: string): number | undefined {
  const upper = name.toUpperCase();
  return SIGNALS[upper.startsWith("SIG") ? upper : `SIG${upper}`];
}

/** The name of a signal number, or undefined. */
export function signalName(number: number): string | undefined {
  return Object.keys(SIGNALS).find((name) => SIGNALS[name] === number);
}

/** A child's exit status as the shell reports it: the code, or 128 + the signal number. */
export function statusOf(status: ExitStatus): number {
  if (status.code !== null) {
    return status.code;
  }
  return 128 + (signalNumber(status.signal ?? "") ?? 1);
}

/**
 * The signals the shell always handles itself: it forwards these to the
 * foreground child, except SIGPIPE, which must not end the whole shell when
 * one of its in-process pipeline stages writes to a pipe nobody reads.
 */
const ALWAYS_HANDLED = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGPIPE"];

/**
 * Tells the kernel which signals the shell handles: the forwarded ones plus
 * every signal with a `trap`. Any other signal ends the shell at once.
 */
export function declareHandledSignals(trapped: Iterable<string>): void {
  const names = new Set(ALWAYS_HANDLED);
  for (const name of trapped) {
    if (name !== "EXIT") {
      names.add(name.startsWith("SIG") ? name : `SIG${name}`);
    }
  }
  const processes = runtime().processes as Partial<ProcessBackend>;
  // Older runtimes (and the test fake) may not have it yet.
  processes.setHandledSignals?.([...names]);
}
