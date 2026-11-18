// Signals as the shell spells and lists them, and which of them it handles.
// The numbers, what a signal does by default and the status of a process a
// signal ended are webnode's own (../../../signals).
import { SIGNAL_NUMBERS, signalNumber } from "../../../signals";
import { runtime } from "../../runtime";

/**
 * The number of a signal as a shell command names it: `SIGINT`, `INT` or
 * `int`. Undefined when there is no such signal.
 */
export function spelledSignalNumber(spelling: string): number | undefined {
  const upper = spelling.toUpperCase();
  return signalNumber(upper.startsWith("SIG") ? upper : `SIG${upper}`);
}

/** How many signals bash puts on a line of its listing. */
const LISTING_COLUMNS = 5;

/**
 * Every signal the table has, numbered, as bash's `kill -l` and `trap -l`
 * print them: in number order, five to a line with a tab between them
 * (` 1) SIGHUP	 2) SIGINT …`).
 */
export function signalListing(): string {
  const signals = Object.entries(SIGNAL_NUMBERS).sort((a, b) => a[1] - b[1]);
  let text = "";
  signals.forEach(([name, number], index) => {
    const endsLine = (index + 1) % LISTING_COLUMNS === 0;
    text += `${String(number).padStart(2)}) ${name}${endsLine ? "\n" : "\t"}`;
  });
  return signals.length % LISTING_COLUMNS === 0 ? text : `${text}\n`;
}

/** What Linux's strsignal says, which bash's `jobs` shows for a job a signal ended. */
const DESCRIPTIONS: Record<string, string> = {
  SIGHUP: "Hangup",
  SIGINT: "Interrupt",
  SIGQUIT: "Quit",
  SIGILL: "Illegal instruction",
  SIGTRAP: "Trace/breakpoint trap",
  SIGABRT: "Aborted",
  SIGBUS: "Bus error",
  SIGFPE: "Floating point exception",
  SIGKILL: "Killed",
  SIGUSR1: "User defined signal 1",
  SIGSEGV: "Segmentation fault",
  SIGUSR2: "User defined signal 2",
  SIGPIPE: "Broken pipe",
  SIGALRM: "Alarm clock",
  SIGTERM: "Terminated",
};

/** How bash describes a job `signal` ended: `Terminated`, `Killed`. */
export function signalDescription(signal: string): string {
  return DESCRIPTIONS[signal] ?? `Unknown signal ${signalNumber(signal) ?? signal}`;
}

/**
 * The signals the shell always handles itself: it forwards these to its
 * foreground programs, except SIGPIPE, which must not end the whole shell
 * when one of its in-process pipeline stages writes to a pipe nobody reads.
 */
const ALWAYS_HANDLED = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGPIPE"];

/**
 * The signals that run the EXIT trap of a shell they end: bash's
 * terminating signals (sig.c), for which it dies only once that trap has
 * run. Any other signal that ends a process (SIGQUIT, SIGPROF, SIGKILL,
 * SIGIO, SIGPWR, SIGSTKFLT) ends the shell without it, as in bash.
 */
const EXIT_TRAP_SIGNALS: ReadonlySet<string> = new Set([
  "SIGHUP",
  "SIGINT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGFPE",
  "SIGBUS",
  "SIGSEGV",
  "SIGSYS",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGUSR1",
  "SIGUSR2",
]);

/** True when `signal`, ending the shell, runs its EXIT trap first (`EXIT_TRAP_SIGNALS`). */
export function runsExitTrap(signal: string): boolean {
  return EXIT_TRAP_SIGNALS.has(signal);
}

/**
 * The signals the shell handles itself, given the names its main shell has
 * traps for (`INT`, `EXIT` …): the forwarded ones and every signal with a
 * trap. With an EXIT trap, also every signal that runs it
 * (`EXIT_TRAP_SIGNALS`): the shell dies of one only after that trap has
 * run, so it must hear of it. Any other signal ends the shell at once, in
 * the kernel.
 */
export function handledSignals(trapped: Iterable<string>): Set<string> {
  const names = new Set(ALWAYS_HANDLED);
  let exitTrap = false;
  for (const name of trapped) {
    if (name === "EXIT") {
      exitTrap = true;
    } else {
      names.add(name.startsWith("SIG") ? name : `SIG${name}`);
    }
  }
  if (exitTrap) {
    for (const name of EXIT_TRAP_SIGNALS) {
      names.add(name);
    }
  }
  return names;
}

/** Tells the kernel which signals the shell handles (`handledSignals`). */
export function declareHandledSignals(trapped: Iterable<string>): void {
  runtime().processes.setHandledSignals([...handledSignals(trapped)]);
}

/**
 * Tells the kernel that the shell handles every signal a process can: while
 * it stands for a program it has exec'd in all but name, each signal sent to
 * it is that program's, and the shell is there to pass it on.
 */
export function declareEverySignalHandled(): void {
  runtime().processes.setHandledSignals(
    Object.keys(SIGNAL_NUMBERS).filter((name) => name !== "SIGKILL" && name !== "SIGSTOP"),
  );
}
