function formatTerminalContent(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n").trim();
}

interface RunnerOutputState {
  /** What the runner printed, if anything. */
  output: string | null;
  errorMessage: string | null;
  /** The runtime status; a recorded one is a plain string. */
  status: string;
}

/**
 * The text of the runner console: the runner's output followed by any runtime
 * error, or while there is neither, what the runtime is doing.
 */
export function describeRunnerOutput({ output, errorMessage, status }: RunnerOutputState): string {
  let content: string;

  if (output) {
    content = errorMessage ? `${output}\n\nRuntime error\n${errorMessage}` : output;
  } else if (errorMessage) {
    content = `Runtime error\n${errorMessage}`;
  } else if (status === "installing") {
    content = "Installing dependencies inside the WebContainer...";
  } else if (status === "starting") {
    content = "Starting the workspace dev server...";
  } else {
    content = "Waiting for runtime output...";
  }

  return formatTerminalContent(content) || "Waiting for runner output...";
}

/** The state classes of a runtime dock tab: the active tab is underlined and lit. */
export function dockTabStateClassName(isActive: boolean): string {
  return isActive
    ? "border-b border-b-[#64a3ff] bg-[#171b22] text-white"
    : "text-slate-300 hover:bg-[#171b22] hover:text-white";
}

/**
 * The size classes of a dock tab's content: it grows into the column while the
 * dock fills it, and otherwise keeps the dock's fixed height.
 */
export function dockContentSizeClassName(fillsColumn: boolean): string {
  return fillsColumn ? "min-h-0 flex-1" : "h-72";
}

/**
 * The size classes of the dock itself: it grows into the column while it fills
 * it, and otherwise keeps its own height (a header row, or that plus the content).
 */
export function dockRootSizeClassName(fillsColumn: boolean): string {
  return fillsColumn ? "min-h-0 flex-1" : "shrink-0";
}

/**
 * The escape codes the docks' consoles colour with. Dim is ANSI 90, which
 * XtermTerminal's theme (brightBlack) keeps at 7:1 on the dock background.
 */
export const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[90m",
  blue: "\u001b[94m",
  cyan: "\u001b[96m",
  green: "\u001b[92m",
  red: "\u001b[91m",
  yellow: "\u001b[93m",
} as const;

/**
 * The docks' console idiom: a line that starts with a tag `pattern` matches
 * gets the tag coloured (the colour `pickPrefixColor` picks for it) and the
 * rest dimmed; any other line, raw program output among them, is left as is.
 */
export function colorizeTaggedLine(
  line: string,
  pattern: RegExp,
  pickPrefixColor: (prefix: string) => string,
): string {
  const prefixMatch = line.match(pattern);

  if (!prefixMatch) {
    return line;
  }

  const prefix = prefixMatch[0];
  const suffix = line.slice(prefix.length);

  return `${pickPrefixColor(prefix)}${prefix}${ANSI.reset}${ANSI.dim}${suffix}${ANSI.reset}`;
}
