import { memo, useEffect, useRef, type CSSProperties } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

interface XtermTerminalProps {
  output: string;
  sessionId: string | null;
  interactive: boolean;
  shouldFocus?: boolean;
  onData?: (input: string) => void;
  onResize?: (size: { cols: number; rows: number }) => void;
}

const TERMINAL_THEME = {
  background: "#1d1f29",
  foreground: "#e2e8f0",
  cursor: "#f8fafc",
  cursorAccent: "#1d1f29",
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

const XtermTerminal = memo(function XtermTerminal({
  output,
  sessionId,
  interactive,
  shouldFocus = false,
  onData,
  onResize,
}: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastOutputRef = useRef("");
  const lastSessionIdRef = useRef<string | null>(null);
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);

  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

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
      theme: interactive ? TERMINAL_THEME : PASSIVE_TERMINAL_THEME,
    });
    const fitAddon = new FitAddon();
    const updateSize = () => {
      fitAddon.fit();
      onResizeRef.current?.({ cols: terminal.cols, rows: terminal.rows });
    };

    terminal.loadAddon(fitAddon);
    terminal.open(container);
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

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    lastOutputRef.current = "";
    lastSessionIdRef.current = null;

    return () => {
      dataDisposable.dispose();
      resizeObserver.disconnect();
      fitAddon.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      lastOutputRef.current = "";
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
    }

    if (output === lastOutputRef.current) {
      return;
    }

    if (!output) {
      terminal.reset();
      lastOutputRef.current = "";
      return;
    }

    if (output.startsWith(lastOutputRef.current)) {
      terminal.write(output.slice(lastOutputRef.current.length));
      lastOutputRef.current = output;
      return;
    }

    terminal.reset();
    terminal.write(output);
    lastOutputRef.current = output;
  }, [output, sessionId]);

  const terminalStyle: TerminalStyle = {
    "--terminal-background": interactive
      ? TERMINAL_THEME.background
      : PASSIVE_TERMINAL_THEME.background,
  };

  return (
    <div
      ref={containerRef}
      className={`xterm-terminal size-full ${interactive ? "" : "passive"}`.trim()}
      style={terminalStyle}
      onMouseDown={(event) => {
        if (!interactive) {
          return;
        }

        event.preventDefault();
        terminalRef.current?.focus();
      }}
    />
  );
});

export default XtermTerminal;
