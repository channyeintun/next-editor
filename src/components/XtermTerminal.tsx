import { useEffect, useEffectEvent, useRef, type CSSProperties } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { findSlidWindowOverlap } from "./terminalOutputOverlap";
import { registerXtermTerminal, unregisterXtermTerminal } from "./xtermRegistry";
import { createXtermCellAnchor } from "./xtermCellAnchor";
import {
  registerCursorCellAnchor,
  unregisterCursorCellAnchor,
} from "../core/src/utils/cursorCellAnchors";

interface XtermTerminalProps {
  output: string;
  sessionId: string | null;
  interactive: boolean;
  /**
   * Names the output region for screen readers ("Runner output", "Console",
   * "Terminal"). A passive terminal's input field takes it too, so it does not
   * announce itself as xterm's "Terminal input".
   */
  label: string;
  /** The id of text that tells the user how to leave the interactive shell. */
  describedBy?: string;
  shouldFocus?: boolean;
  scrollLine?: number;
  /**
   * Keeps text that slid off the front of a capped `output` in the scrollback,
   * so a full log appends each chunk instead of being re-rendered whole (which
   * also threw away the viewer's scroll position). Leave it off while scroll
   * lines are recorded or replayed: they index a buffer that holds exactly
   * `output`.
   */
  keepScrolledOffOutput?: boolean;
  onData?: (input: string) => void;
  onResize?: (size: { cols: number; rows: number }) => void;
  onScroll?: (scrollLine: number) => void;
}

const TERMINAL_THEME = {
  background: "#15191f",
  foreground: "#e2e8f0",
  cursor: "#f8fafc",
  cursorAccent: "#15191f",
  selectionBackground: "#33415588",
  black: "#0f172a",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#f472b6",
  cyan: "#22d3ee",
  white: "#e2e8f0",
  // ANSI 90: the dimmed text after every console [tag]. Slate-400, 6.71:1 on
  // the background before minimumContrastRatio lifts it to 7:1.
  brightBlack: "#90a1b9",
  brightRed: "#fb7185",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#f9a8d4",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
} as const;

const PASSIVE_TERMINAL_THEME = {
  ...TERMINAL_THEME,
  cursor: "transparent",
  cursorAccent: "transparent",
} as const;

/** Keys held down on the way to a chord; they keep a pending Escape alive. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

type TerminalStyle = CSSProperties & {
  "--terminal-background"?: string;
};

function XtermTerminal({
  output,
  sessionId,
  interactive,
  label,
  describedBy,
  shouldFocus = false,
  scrollLine,
  keepScrolledOffOutput = false,
  onData,
  onResize,
  onScroll,
}: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastOutputRef = useRef("");
  // The buffer holds lines above lastOutputRef's text: it slid while
  // keepScrolledOffOutput was on.
  const hasScrolledOffOutputRef = useRef(false);
  const lastSessionIdRef = useRef<string | null>(null);
  // The terminal outlives a change of callback props, so its listeners always
  // call the latest ones.
  const emitData = useEffectEvent((input: string) => onData?.(input));
  const emitResize = useEffectEvent((size: { cols: number; rows: number }) => onResize?.(size));
  const emitScroll = useEffectEvent((line: number) => onScroll?.(line));

  // A change of `interactive` rebuilds the terminal, so the constructor
  // options below are the only place cursorBlink and disableStdin are set.
  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: interactive,
      disableStdin: !interactive,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.5,
      scrollback: 2000,
      // The DOM renderer hides its rows from assistive technology; this mode
      // adds xterm's readable row list (and a live region, which index.css
      // silences on passive outputs).
      screenReaderMode: true,
      // xterm lightens any cell below 7:1 against its background (WCAG AAA),
      // including colours a program picks itself, such as ANSI black.
      minimumContrastRatio: 7,
      theme: interactive ? TERMINAL_THEME : PASSIVE_TERMINAL_THEME,
    });
    const fitAddon = new FitAddon();
    const updateSize = () => {
      fitAddon.fit();
      emitResize({ cols: terminal.cols, rows: terminal.rows });
    };

    terminal.loadAddon(fitAddon);
    terminal.open(container);
    if (!interactive) {
      terminal.textarea?.setAttribute("aria-label", label);
    }
    // xterm keeps Tab and Shift+Tab for the shell, which traps keyboard focus.
    // Returning false hands a key back to the browser: a passive output lets
    // Tab move focus at once, and the shell lets it after an Escape, so Tab
    // still completes commands.
    let leaveOnTab = false;
    terminal.attachCustomKeyEventHandler((event) => {
      const isPlainTab = event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey;
      if (!interactive) {
        return !isPlainTab;
      }
      if (event.type !== "keydown" || MODIFIER_KEYS.has(event.key)) {
        return true;
      }
      if (isPlainTab && leaveOnTab) {
        leaveOnTab = false;
        return false;
      }
      leaveOnTab = event.key === "Escape";
      return true;
    });
    if (describedBy) {
      terminal.textarea?.setAttribute("aria-describedby", describedBy);
    }
    updateSize();

    const resizeObserver = new ResizeObserver(() => {
      updateSize();
    });
    resizeObserver.observe(container);

    const dataDisposable = terminal.onData((input) => {
      if (interactive) {
        emitData(input);
      }
    });
    const scrollDisposable = terminal.onScroll((line) => {
      emitScroll(line);
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    lastOutputRef.current = "";
    hasScrolledOffOutputRef.current = false;
    lastSessionIdRef.current = null;
    registerXtermTerminal(container, terminal);
    // Pointer samples over the console record the line and character they sit
    // on, so playback finds the same line however many rows the viewer fits.
    const cellAnchor = createXtermCellAnchor(container, terminal);
    registerCursorCellAnchor(container, cellAnchor);

    return () => {
      unregisterCursorCellAnchor(container, cellAnchor);
      cellAnchor.dispose();
      unregisterXtermTerminal(container, terminal);
      dataDisposable.dispose();
      scrollDisposable.dispose();
      resizeObserver.disconnect();
      fitAddon.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      lastOutputRef.current = "";
      hasScrolledOffOutputRef.current = false;
      lastSessionIdRef.current = null;
    };
  }, [interactive]);

  useEffect(() => {
    const terminal = terminalRef.current;

    if (!terminal) {
      return;
    }

    if (shouldFocus) {
      terminal.focus();
    }
  }, [shouldFocus, sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;

    if (!terminal) {
      return;
    }

    if (lastSessionIdRef.current !== sessionId) {
      terminal.reset();
      lastSessionIdRef.current = sessionId;
      lastOutputRef.current = "";
      hasScrolledOffOutputRef.current = false;
    }

    // Recording or replaying scroll lines again: drop the extra scrollback.
    const mustRewrite = !keepScrolledOffOutput && hasScrolledOffOutputRef.current;

    if (output === lastOutputRef.current && !mustRewrite) {
      return;
    }

    if (!output) {
      terminal.reset();
      lastOutputRef.current = "";
      hasScrolledOffOutputRef.current = false;
      return;
    }

    // `write` parses asynchronously, so scrolling on the next statement runs
    // against the pre-write buffer: `scrollToLine` clamps to a much smaller
    // `ybase` (often 0), which leaves the viewport "following" and pins it to the
    // bottom once the parse flushes. `scrollLine` is only ever supplied during
    // playback, so this silently defeated the replay fidelity it exists for.
    // The write callback runs after the parser has updated the buffer.
    const scrollAfterWrite = () => {
      if (scrollLine === undefined || terminalRef.current !== terminal) {
        return;
      }
      terminal.scrollToLine(scrollLine);
    };

    // How much of `output` the terminal already shows; -1 rewrites it whole.
    const lastOutput = lastOutputRef.current;
    let writtenLength = -1;

    if (!mustRewrite && output.startsWith(lastOutput)) {
      writtenLength = lastOutput.length;
    } else if (keepScrolledOffOutput) {
      // Once a capped log is full, each chunk drops text off its front, so the
      // output no longer starts with what was written; the overlap with the
      // written text's tail finds where the new text begins.
      writtenLength = findSlidWindowOverlap(lastOutput, output);
    }

    if (writtenLength >= 0) {
      terminal.write(output.slice(writtenLength), scrollAfterWrite);
      lastOutputRef.current = output;

      if (writtenLength < lastOutput.length) {
        hasScrolledOffOutputRef.current = true;
      }

      return;
    }

    terminal.reset();
    terminal.write(output, scrollAfterWrite);
    lastOutputRef.current = output;
    hasScrolledOffOutputRef.current = false;
  }, [keepScrolledOffOutput, output, scrollLine, sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;

    if (!terminal || scrollLine === undefined) {
      return;
    }

    // Same ordering hazard: this fires in the same commit as the output effect,
    // i.e. still before that write has flushed. An empty write schedules the
    // scroll behind whatever is already queued in the parser.
    terminal.write("", () => {
      if (terminalRef.current !== terminal) {
        return;
      }
      terminal.scrollToLine(scrollLine);
    });
  }, [scrollLine]);

  const terminalStyle: TerminalStyle = {
    "--terminal-background": interactive
      ? TERMINAL_THEME.background
      : PASSIVE_TERMINAL_THEME.background,
  };
  const cursorReplayTargetId = sessionId ? `terminal-${sessionId}` : "terminal-empty";

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={label}
      className={`xterm-terminal size-full ${interactive ? "" : "passive"}`.trim()}
      style={terminalStyle}
      data-cursor-replay-target={cursorReplayTargetId}
      onMouseDown={(event) => {
        if (!interactive) {
          return;
        }

        event.preventDefault();
        terminalRef.current?.focus();
      }}
    />
  );
}

export default XtermTerminal;
