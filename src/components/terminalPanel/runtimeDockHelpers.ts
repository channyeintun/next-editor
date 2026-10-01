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
    : "text-slate-400 hover:bg-[#171b22] hover:text-white";
}

/**
 * The runtime dock's tab strip. It takes the header's spare width and scrolls
 * sideways (scrollbar hidden; touch and trackpad still scroll it) once the tabs
 * outgrow it, so the full-height and collapse controls after it keep their
 * place and their 40px touch target on a narrow phone dock instead of being
 * clipped off the end of the header.
 */
export const DOCK_TAB_STRIP_CLASS =
  "flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
