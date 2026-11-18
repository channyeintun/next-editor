// Signals as Node's API takes them (`process.kill`, `child.kill`,
// `--watch-kill-signal`): by any name `os.constants.signals` has, aliases
// included, or by number, mapped to the kernel's names (../../signals).
import { signalName } from "../../signals";
import { signals as nodeSignals } from "./os";

function unknownSignal(signal: string | number): TypeError {
  return Object.assign(new TypeError(`Unknown signal: ${signal}`), { code: "ERR_UNKNOWN_SIGNAL" });
}

/**
 * The kernel's name (src/core/webnode/signals.ts) for a signal given by any
 * name Node knows (`os.constants.signals`, SIGIOT and SIGPOLL included) or
 * by number.
 */
export function kernelSignalName(signal: string | number | undefined): string {
  if (signal === undefined) {
    return "SIGTERM";
  }
  if (signal === 0) {
    return "0";
  }
  const name = signalName(typeof signal === "number" ? signal : nodeSignalNumber(signal));
  if (name === undefined) {
    throw unknownSignal(signal);
  }
  return name;
}

/** The number of signal `name`, any name Node knows, or 0. */
export function nodeSignalNumber(name: string): number {
  return Object.hasOwn(nodeSignals, name) ? nodeSignals[name] : 0;
}
