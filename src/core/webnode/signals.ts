// Signals: their Linux numbers, what one does to a process that does not
// handle it, and the exit status of a process a signal ended. The kernel
// applies the default action to processes; a program that runs work of its own
// as if it were a process (the shell's in-process jobs) applies the same rule,
// from here.

/** Linux's signal numbers (x86-64), by name. */
export const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
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
  SIGSTKFLT: 16,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPWR: 30,
  SIGSYS: 31,
};

/** The number of signal `name` (`"SIGTERM"`), or undefined when there is no such signal. */
export function signalNumber(name: string): number | undefined {
  return Object.hasOwn(SIGNAL_NUMBERS, name) ? SIGNAL_NUMBERS[name] : undefined;
}

/** The name of signal `number` (15 is `"SIGTERM"`), or undefined when there is no such signal. */
export function signalName(number: number): string | undefined {
  return Object.keys(SIGNAL_NUMBERS).find((name) => SIGNAL_NUMBERS[name] === number);
}

/** The exit status a shell gives a process `signal` ended: 128 + the signal's number. */
export function signalExitStatus(signal: string): number {
  return 128 + (signalNumber(signal) ?? 0);
}

/**
 * An exit status as the one number a shell makes of it (`$?`): the exit
 * code, or `signalExitStatus` of the signal that ended the process.
 */
export function exitStatusNumber(status: { code: number | null; signal: string | null }): number {
  return status.code ?? signalExitStatus(status.signal ?? "");
}

/** Signals whose default action is to do nothing, as in POSIX. */
const IGNORED_BY_DEFAULT = new Set(["SIGCHLD", "SIGCONT", "SIGURG", "SIGWINCH"]);

/**
 * Signals that stop a process. Stopping one is not supported here, so their
 * default action does nothing (and SIGSTOP, which cannot be handled, does
 * nothing at all).
 */
const STOP_SIGNALS = new Set(["SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU"]);

/** True when `signal` (`"SIGTERM"`) ends a process that does not handle it. */
export function endsByDefault(signal: string): boolean {
  return !IGNORED_BY_DEFAULT.has(signal) && !STOP_SIGNALS.has(signal);
}
