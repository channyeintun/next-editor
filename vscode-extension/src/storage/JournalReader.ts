import { createReadStream } from "node:fs";
import type { SessionEvent } from "../model/events";

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
// discardable incomplete final line; a malformed line before the tail ends
// recovery at the last verified sequence and records corruption.
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

  const lines: { text: string; offset: number; terminated: boolean }[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    let pending = "";
    let pendingOffset = 0;
    let byteOffset = 0;
    stream.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      pending += text;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex);
        lines.push({ text: line, offset: pendingOffset, terminated: true });
        const consumed = Buffer.byteLength(line, "utf8") + 1;
        pendingOffset += consumed;
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
      byteOffset += Buffer.byteLength(text, "utf8");
      void byteOffset;
    });
    stream.on("end", () => {
      if (pending.length > 0) {
        lines.push({ text: pending, offset: pendingOffset, terminated: false });
      }
      resolve();
    });
    stream.on("error", reject);
  });

  let expectedSeq = 0;
  let lastTUs = -1;

  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i] as {
      text: string;
      offset: number;
      terminated: boolean;
    };
    const isLast = i === lines.length - 1;
    if (entry.text.trim() === "") {
      if (!isLast) {
        result.corruption = { line: i, message: "empty line inside journal" };
        return result;
      }
      continue;
    }

    const fail = (message: string): boolean => {
      if (isLast) {
        // Discardable tail: a crash may cut mid-line (plan §9.3).
        result.truncatedTailBytes = Buffer.byteLength(entry.text, "utf8");
        return false;
      }
      result.corruption = { line: i, message };
      return true;
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.text);
    } catch {
      if (fail("invalid JSON")) {
        return result;
      }
      continue;
    }

    const validationError = validate ? validate(parsed) : null;
    if (validationError !== null) {
      if (fail(`schema: ${validationError}`)) {
        return result;
      }
      continue;
    }

    const event = parsed as SessionEvent;
    if (typeof event.seq !== "number" || event.seq !== expectedSeq) {
      if (fail(`sequence gap: expected ${expectedSeq}, got ${String(event.seq)}`)) {
        return result;
      }
      continue;
    }
    if (typeof event.tUs !== "number" || event.tUs < lastTUs) {
      if (fail(`decreasing timestamp at seq ${event.seq}`)) {
        return result;
      }
      continue;
    }

    result.events.push(event);
    result.byteOffsets.push(entry.offset);
    expectedSeq += 1;
    lastTUs = event.tUs;
  }

  return result;
}
