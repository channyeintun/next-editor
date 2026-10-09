import { useEffect, useRef, type CSSProperties } from "react";
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
  brightBlack: "#475569",
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

type TerminalStyle = CSSProperties & {
  "--terminal-background"?: string;
};

function XtermTerminal({
  output,
  sessionId,
  interactive,
  label,
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
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const onScrollRef = useRef(onScroll);

  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    onScrollRef.current = onScroll;
  }, [onScroll]);

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
      theme: interactive ? TERMINAL_THEME : PASSIVE_TERMINAL_THEME,
    });
    const fitAddon = new FitAddon();
    const updateSize = () => {
      fitAddon.fit();
      onResizeRef.current?.({ cols: terminal.cols, rows: terminal.rows });
    };

    terminal.loadAddon(fitAddon);
    terminal.open(container);
    if (!interactive) {
      terminal.textarea?.setAttribute("aria-label", label);
    }
    updateSize();

    const resizeObserver = new ResizeObserver(() => {
      updateSize();
    });
    resizeObserver.observe(container);

    const dataDisposable = terminal.onData((input) => {
      if (interactive) {
        onDataRef.current?.(input);
      }
    });
    const scrollDisposable = terminal.onScroll((line) => {
      onScrollRef.current?.(line);
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

    terminal.options.disableStdin = !interactive;
    terminal.options.cursorBlink = interactive;
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
