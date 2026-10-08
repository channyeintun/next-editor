import type { Terminal } from "@xterm/xterm";

/**
 * The live xterm instance behind each mounted terminal container, so code
 * outside the component — the studio pointing at a console line — can read the
 * terminal's buffer instead of guessing from the rendered DOM. Weakly held: an
 * unmounted container takes its entry with it.
 */
const terminalsByContainer = new WeakMap<Element, Terminal>();

export function registerXtermTerminal(container: Element, terminal: Terminal): void {
  terminalsByContainer.set(container, terminal);
}

export function unregisterXtermTerminal(container: Element, terminal: Terminal): void {
  if (terminalsByContainer.get(container) === terminal) {
    terminalsByContainer.delete(container);
  }
}

export function getXtermTerminal(container: Element): Terminal | undefined {
  return terminalsByContainer.get(container);
}
