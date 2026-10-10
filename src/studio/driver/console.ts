import type { Terminal } from "@xterm/xterm";
import { easePointerAim, pointerAimDurationMs } from "../../core/src/utils/pointerMotion";
import { getXtermTerminal } from "../../components/xtermRegistry";
import {
  appendRunnerConsoleLines,
  beginRunnerOperation,
} from "../../runtime/playgroundConsoleStore";
import { selectIsCollapsed } from "../../stores/runtimePanelStore";
import { StudioActionError, tween, waitUntil } from "../async";
import { consoleLineAimPoint, findConsoleLine, type ConsoleLineLookup } from "../consoleLines";
import {
  PlaygroundTerminalError,
  preparePlaygroundRun,
  runErrorPrefixFor,
} from "../playgroundRuntime";
import { isPlaygroundRuntime, isPlaygroundRuntimeKind } from "../plan";
import type { StudioDriver, StudioDriverDeps } from "./index";
import { isCoveredAt, roundPoint, type StudioPointer } from "./pointer";

/**
 * The runner dock and its console: a Playground run, pointing at a printed
 * line, waiting for output, and opening or shutting the dock.
 */

/**
 * Where a console row's text ends on screen (its last non-blank character), or
 * null when the renderer draws no DOM text (a canvas/WebGL renderer) or the
 * page cannot measure it.
 */
function paintedTextRight(row: Element | undefined): number | null {
  if (!row || typeof document.createRange !== "function") return null;
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let lastNode: Text | null = null;
  let lastIndex = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const trimmed = text.data.replace(/\s+$/u, "");
    if (trimmed.length > 0) {
      lastNode = text;
      lastIndex = trimmed.length;
    }
  }
  if (!lastNode) return null;
  try {
    const range = document.createRange();
    range.setStart(row, 0);
    range.setEnd(lastNode, lastIndex);
    const rights = [...range.getClientRects()]
      .filter((rect) => rect.width > 0)
      .map((rect) => rect.right);
    return rights.length > 0 ? Math.max(...rights) : null;
  } catch {
    return null;
  }
}

// The console on screen: the visible terminal inside the runtime dock, with
// the live xterm instance behind it (null while the dock is shut).
function visibleConsole(): { container: Element; terminal: Terminal } | null {
  const dock = document.querySelector('[data-cursor-replay-target="runtime-dock"]');
  if (!dock) return null;
  for (const container of dock.querySelectorAll('[data-cursor-replay-target^="terminal-"]')) {
    const rect = container.getBoundingClientRect();
    const terminal = getXtermTerminal(container);
    if (terminal && rect.width > 0 && rect.height > 0) {
      return { container, terminal };
    }
  }
  return null;
}

export function consoleCommands(
  deps: Pick<
    StudioDriverDeps,
    "runtime" | "runtimeMode" | "runtimePanelStore" | "workspace" | "notifyRuntimeEvent" | "signal"
  >,
  pointer: StudioPointer,
): Pick<
  StudioDriver,
  "runWorkspace" | "pointConsole" | "waitForOutput" | "expandRuntimeDock" | "collapseRuntimeDock"
> {
  const { signal } = deps;
  // The header line the latest Playground run printed, so pointing at the
  // console reads that run's output and not an earlier one's identical line.
  let lastRunHeader: string | null = null;

  return {
    async pointConsole({ target, durationMs, timeoutMs }) {
      // Wait for the line to be printed (a point lands while the output is still
      // arriving), then point at it. A line that scrolled out of view, or never
      // appears, fails the render: pointing at nothing would teach nothing.
      type VisibleLine = Extract<ConsoleLineLookup, { status: "visible" }>;
      // Written from inside the wait's predicate, so declared without the
      // narrowing a plain `= null` initializer would pin on it.
      let found = null as { container: Element; terminal: Terminal; line: VisibleLine } | null;
      const described = `console line ${target.occurrence} containing ${JSON.stringify(target.text)}`;
      await waitUntil(
        () => {
          const surface = visibleConsole();
          if (!surface) return false;
          const lookup = findConsoleLine({
            buffer: surface.terminal.buffer.active,
            rows: surface.terminal.rows,
            text: target.text,
            occurrence: target.occurrence,
            runHeader: lastRunHeader,
          });
          if (lookup.status === "offscreen") {
            throw new StudioActionError(
              `The ${described} has scrolled out of the console's view — point at lines that are on screen`,
            );
          }
          if (lookup.status !== "visible") return false;
          found = { ...surface, line: lookup };
          return true;
        },
        {
          timeoutMs,
          signal,
          description: `the ${described} in the latest run's output (is the runner dock open?)`,
        },
      );
      if (!found) {
        throw new StudioActionError(`The ${described} was not found`);
      }
      const { container, terminal, line: visible } = found;
      const screenRect = (
        container.querySelector(".xterm-screen") ?? container
      ).getBoundingClientRect();
      const row = container.querySelectorAll(".xterm-rows > div")[visible.viewportRow];
      const aim = roundPoint(
        consoleLineAimPoint(
          visible,
          screenRect,
          { cols: terminal.cols, rows: terminal.rows },
          paintedTextRight(row),
        ),
      );
      if (isCoveredAt(aim, container)) {
        throw new StudioActionError(`The ${described} is covered on screen`);
      }

      // A hidden pointer appears at the line; a visible one travels there the
      // way it does toward a control — no click: it points, then rests.
      const from = pointer.isHidden() ? null : pointer.lastPoint();
      const travelMs = from
        ? Math.min(durationMs, pointerAimDurationMs(Math.hypot(aim.x - from.x, aim.y - from.y)))
        : 0;
      if (!from) {
        pointer.revealAt(aim);
        // The reveal's own sample is placed by plain hit-testing, which can find
        // an overlay outside the recorded app; record the rest again through
        // the console so it is anchored to the line, as every move is.
        pointer.dispatch(aim.x, aim.y, container);
      } else {
        await tween(travelMs, easePointerAim, signal, (eased) => {
          pointer.dispatch(
            Math.round(from.x + (aim.x - from.x) * eased),
            Math.round(from.y + (aim.y - from.y) * eased),
            container,
          );
        });
      }
      return { line: visible.line.text, travelMs };
    },

    async runWorkspace(timeoutMs) {
      const runtime = deps.runtime;
      if (!isPlaygroundRuntime(runtime)) {
        throw new StudioActionError(
          `runtime.run requires a Playground runtime, got "${runtime.kind}"`,
        );
      }

      // The dock is where this output is about to land, so a run opens it — the
      // same reflex TerminalPanel's consoleOpener has when a command writes to
      // the terminal. That lets a script collapse the dock for the long stretch
      // before any code runs (an empty console is 288px of editor spent on
      // nothing) and get it back at the run, with no second action to remember.
      // A no-op when the dock is already open, which is the default.
      if (selectIsCollapsed(deps.runtimePanelStore.getSnapshot().context)) {
        pointer.pinToApp();
      }
      deps.runtimePanelStore.trigger.setIsCollapsed({ collapsed: false });

      const prepared = preparePlaygroundRun({
        runtime,
        mode: deps.runtimeMode,
        project: deps.workspace.getProject(),
        timeoutMs,
        signal,
      });
      lastRunHeader = prepared.startedLines.at(-1) ?? null;
      beginRunnerOperation(deps.runtimePanelStore, prepared.startedLines);

      let outcome;
      try {
        outcome = await prepared.run();
      } catch (error) {
        if (error instanceof PlaygroundTerminalError) {
          appendRunnerConsoleLines(deps.runtimePanelStore, error.consoleLines);
        }
        throw error;
      }

      appendRunnerConsoleLines(deps.runtimePanelStore, outcome.resultLines);

      if (!outcome.ok) {
        throw new StudioActionError(`The program did not run cleanly (status ${outcome.status})`);
      }

      return {
        kind: deps.runtime.kind,
        mode: deps.runtimeMode,
        status: outcome.status,
        attempts: outcome.attempts,
        transientFailures: outcome.transientFailures,
      };
    },

    async expandRuntimeDock(timeoutMs) {
      const panel = deps.runtimePanelStore;
      if (!selectIsCollapsed(panel.getSnapshot().context)) {
        return { expanded: true, alreadyExpanded: true };
      }

      // The pointer has just clicked the chevron; it stays where it is while
      // the dock opens under it.
      pointer.pinToApp();
      panel.trigger.setIsCollapsed({ collapsed: false });
      await waitUntil(() => !selectIsCollapsed(panel.getSnapshot().context), {
        timeoutMs,
        signal,
        description: "the runner dock to open",
      });
      // Captured at the action's time, as collapseRuntimeDock does.
      deps.notifyRuntimeEvent();
      return { expanded: true };
    },

    async collapseRuntimeDock(timeoutMs) {
      const panel = deps.runtimePanelStore;
      if (selectIsCollapsed(panel.getSnapshot().context)) {
        return { collapsed: true, alreadyCollapsed: true };
      }

      pointer.pinToApp();
      panel.trigger.setIsCollapsed({ collapsed: true });
      await waitUntil(() => selectIsCollapsed(panel.getSnapshot().context), {
        timeoutMs,
        signal,
        description: "the runner dock to collapse",
      });

      // The dock records itself by diffing its own state on render, so the
      // recording only learns about this once the panel has re-rendered. Nudging
      // the runtime track here means the collapse is captured at the action's
      // time rather than whenever the next unrelated runtime change lands — a
      // gap that would otherwise leave the dock covering the editor on replay.
      deps.notifyRuntimeEvent();
      return { collapsed: true };
    },

    async waitForOutput({ contains, timeoutMs }) {
      const errorPrefix = isPlaygroundRuntimeKind(deps.runtime.kind)
        ? runErrorPrefixFor(deps.runtime.kind)
        : null;
      let matchedLine: string | null = null;
      await waitUntil(
        () => {
          const lines = deps.runtimePanelStore.getSnapshot().context.consoleLines;
          const errorLine = errorPrefix
            ? lines.find((line) => line.startsWith(errorPrefix))
            : undefined;
          if (errorLine) {
            throw new StudioActionError(`The run reported an error: ${errorLine}`);
          }
          matchedLine = lines.find((line) => line.includes(contains)) ?? null;
          return matchedLine !== null;
        },
        {
          timeoutMs,
          signal,
          description: `console output containing ${JSON.stringify(contains)}`,
        },
      );
      return { matchedLine };
    },
  };
}
