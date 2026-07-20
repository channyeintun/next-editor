import { createReadStream } from "node:fs";
import type { SessionEvent } from "../model/events";
import { LIMITS } from "../model/limits";

export type JournalReadResult = {
  events: SessionEvent[];
  /** Byte offset of the start of each event line. */
  byteOffsets: number[];
  /** Bytes discarded from an incomplete/unusable final line. */
  truncatedTailBytes: number;
  /** Malformed line before the tail: recovery stops at the previous event. */
  corruption: { line: number; message: string } | null;
};

export type EventValidator = (raw: unknown) => string | null;

// Streaming NDJSON reader with recovery semantics (plan §9.3): one
// discardable unterminated final line; any malformed newline-terminated
// record ends recovery at the last verified sequence and records corruption.
export async function readJournal(
  file: string,
  validate?: EventValidator,
): Promise<JournalReadResult> {
  const result: JournalReadResult = {
    events: [],
    byteOffsets: [],
    truncatedTailBytes: 0,
    corruption: null,
  };

  let expectedSeq = 0;
  let lastTUs = -1;
  let lineNumber = 0;

  const acceptLine = (text: string, offset: number, terminated: boolean): void => {
    if (result.corruption) {
      return;
    }
    const currentLine = lineNumber++;
    const tailBytes = Buffer.byteLength(text, "utf8");
    const fail = (message: string): void => {
      if (!terminated) {
        result.truncatedTailBytes = tailBytes;
      } else {
        result.corruption = { line: currentLine, message };
      }
    };

    if (text.trim() === "") {
      fail("empty line inside journal");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail("invalid JSON");
      return;
    }
    const validationError = validate ? validate(parsed) : null;
    if (validationError !== null) {
      fail(`schema: ${validationError}`);
      return;
    }

    const event = parsed as SessionEvent;
    if (event.seq !== expectedSeq) {
      fail(`sequence gap: expected ${expectedSeq}, got ${String(event.seq)}`);
      return;
    }
    if (event.tUs < lastTUs) {
      fail(`decreasing timestamp at seq ${event.seq}`);
      return;
    }
    if (result.events.length >= LIMITS.maxEventsPerSession) {
      fail(`event count exceeds ${LIMITS.maxEventsPerSession}`);
      return;
    }

    result.events.push(event);
    result.byteOffsets.push(offset);
    expectedSeq += 1;
    lastTUs = event.tUs;
  };

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.setEncoding("utf8");
    let pending = "";
    let pendingOffset = 0;
    stream.on("data", (text: string) => {
      if (result.corruption) {
        return;
      }
      pending += text;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex);
        acceptLine(line, pendingOffset, true);
        if (result.corruption) {
          pending = "";
          break;
        }
        const consumed = Buffer.byteLength(line, "utf8") + 1;
        pendingOffset += consumed;
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
    });
    stream.on("end", () => {
      if (!result.corruption && pending.length > 0) {
        acceptLine(pending, pendingOffset, false);
      }
      resolve();
    });
    stream.on("error", reject);
  });

  return result;
}
