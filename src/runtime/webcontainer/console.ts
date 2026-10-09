// What the runtime's consoles show: process output without its terminal
// control sequences, errors the preview reports, and runtime failures.
import type { RuntimePreviewMessage } from "../../types/runtime";

const ESCAPE_CHARACTER = String.fromCharCode(27);
const BELL_CHARACTER = String.fromCharCode(7);
const OSC_PATTERN = new RegExp(
  `${ESCAPE_CHARACTER}\\][^${BELL_CHARACTER}]*(?:${BELL_CHARACTER}|${ESCAPE_CHARACTER}\\\\)`,
  "g",
);

export function getRuntimeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown WebContainer runtime error";
}

function stringifyPreviewMessageArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable preview error]";
  }
}

export function formatPreviewMessage(message: {
  args?: unknown[];
  message?: string;
  pathname?: string;
  port?: number;
  type?: string;
}): Omit<RuntimePreviewMessage, "id"> {
  const normalizedType = message.type?.toLowerCase();
  const kind =
    normalizedType === "console-error" || normalizedType === "preview_console_error"
      ? "console-error"
      : normalizedType === "unhandledrejection" ||
          normalizedType === "unhandled-rejection" ||
          normalizedType === "preview_unhandled_rejection"
        ? "unhandled-rejection"
        : "uncaught-exception";
  const text =
    kind === "console-error"
      ? (message.args ?? []).map(stringifyPreviewMessageArg).join(" ") ||
        "console.error called inside preview"
      : message.message?.trim() || "Preview error";

  return {
    kind,
    text,
    port: typeof message.port === "number" ? message.port : null,
    pathname: message.pathname ?? "",
  };
}

export function sanitizeTerminalChunk(chunk: string): string {
  const withoutOsc = chunk.replace(OSC_PATTERN, "");
  const normalized = withoutOsc.replace(/\r/g, "");

  if (/^[\\|/-]$/.test(normalized.trim())) {
    return "";
  }

  return normalized;
}
