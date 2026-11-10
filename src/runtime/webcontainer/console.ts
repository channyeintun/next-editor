// What the runtime's consoles show: process output without its terminal
// control sequences, errors the preview reports, and runtime failures.
import type { RuntimePreviewMessage } from "../../types/runtime";

const ESCAPE_CHARACTER = String.fromCharCode(27);
const BELL_CHARACTER = String.fromCharCode(7);
const OSC_OPENER = `${ESCAPE_CHARACTER}]`;
const STRING_TERMINATOR = `${ESCAPE_CHARACTER}\\`;

/**
 * `chunk` without its OSC sequences (window titles, hyperlinks, shell integration
 * marks). A sequence runs from `ESC ]` through the next bell. When no bell follows
 * it, it runs through the last `ESC \` of the chunk, and with neither it is left
 * as it is.
 *
 * That is what the pattern `ESC ] [^BEL]* (BEL | ESC \)` matched, which this
 * replaces. From an opener with no bell after it, the pattern ran to the end of the
 * chunk and back looking for a terminator, and then did the same from the next
 * opener: quadratic in a chunk of unclosed openers, which a process in the runner
 * can write, on the main thread that cleans every output chunk. Each search here
 * starts where the last one ended, so the chunk is read a fixed number of times.
 */
function stripOscSequences(chunk: string): string {
  let opener = chunk.indexOf(OSC_OPENER);
  if (opener < 0) {
    return chunk;
  }

  const kept: string[] = [];
  let keptFrom = 0;
  while (opener >= 0) {
    const bell = chunk.indexOf(BELL_CHARACTER, opener + OSC_OPENER.length);
    let end: number;
    if (bell >= 0) {
      end = bell + BELL_CHARACTER.length;
    } else {
      // No bell from here on, so no later opener can end at one either: this one
      // takes the last string terminator, or none is left to take.
      const terminator = chunk.lastIndexOf(STRING_TERMINATOR);
      if (terminator < opener + OSC_OPENER.length) {
        break;
      }
      end = terminator + STRING_TERMINATOR.length;
    }
    kept.push(chunk.slice(keptFrom, opener));
    keptFrom = end;
    opener = chunk.indexOf(OSC_OPENER, end);
  }
  kept.push(chunk.slice(keptFrom));

  return kept.join("");
}

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
  const withoutOsc = stripOscSequences(chunk);
  const normalized = withoutOsc.replace(/\r/g, "");

  // A spinner frame is a redraw with no newline; a program that prints a
  // line holding only one of these characters still ends it with "\n".
  if (!withoutOsc.includes("\n") && /^[\\|/-]$/.test(normalized.trim())) {
    return "";
  }

  return normalized;
}
