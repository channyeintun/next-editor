import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { sanitizeTerminalChunk } from "./console";

const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);

describe("sanitizeTerminalChunk", () => {
  it("keeps a printed line that is a single spinner character", () => {
    expect(sanitizeTerminalChunk("-\n")).toBe("-\n");
    expect(sanitizeTerminalChunk("|\r\n")).toBe("|\n");
    expect(sanitizeTerminalChunk("/\n")).toBe("/\n");
    expect(sanitizeTerminalChunk("\\\n")).toBe("\\\n");
  });

  it("drops a spinner frame that redraws without a newline", () => {
    expect(sanitizeTerminalChunk("\r-")).toBe("");
    expect(sanitizeTerminalChunk("|")).toBe("");
    expect(sanitizeTerminalChunk("\\")).toBe("");
    expect(sanitizeTerminalChunk(`${ESCAPE}]0;pnpm${BELL}\r/`)).toBe("");
  });

  it("strips carriage returns and OSC sequences from other output", () => {
    expect(sanitizeTerminalChunk("ready\r\n")).toBe("ready\n");
    expect(sanitizeTerminalChunk(`${ESCAPE}]0;title${BELL}hello\n`)).toBe("hello\n");
    expect(sanitizeTerminalChunk(`${ESCAPE}]0;title${ESCAPE}\\done\n`)).toBe("done\n");
  });

  it("strips an OSC sequence up to the bell after it, or else the last string terminator", () => {
    // What the pattern this replaced matched, kept as it was.
    expect(sanitizeTerminalChunk(`a${ESCAPE}]0;x${BELL}b${ESCAPE}]0;y${BELL}c\n`)).toBe("abc\n");
    expect(sanitizeTerminalChunk(`a${ESCAPE}]0;x${ESCAPE}\\b${BELL}c\n`)).toBe("ac\n");
    expect(sanitizeTerminalChunk(`a${ESCAPE}]8;;x${ESCAPE}\\b${ESCAPE}]8;;${ESCAPE}\\c\n`)).toBe(
      "ac\n",
    );
    expect(sanitizeTerminalChunk(`a${ESCAPE}]0;never closed\n`)).toBe(
      `a${ESCAPE}]0;never closed\n`,
    );
    expect(sanitizeTerminalChunk(`${ESCAPE}\\a${ESCAPE}]${ESCAPE}]\n`)).toBe(
      `${ESCAPE}\\a${ESCAPE}]${ESCAPE}]\n`,
    );
  });

  it("strips exactly what the OSC pattern it replaced stripped", () => {
    const pattern = new RegExp(`${ESCAPE}\\][^${BELL}]*(?:${BELL}|${ESCAPE}\\\\)`, "g");
    // No spinner characters or carriage returns, so only the OSC step changes the chunk.
    const piece = fc.constantFrom(ESCAPE, "]", BELL, "\\", `${ESCAPE}]`, `${ESCAPE}\\`, "a", "\n");

    fc.assert(
      fc.property(fc.array(piece, { maxLength: 24 }), (pieces) => {
        const chunk = `x${pieces.join("")}`;
        expect(sanitizeTerminalChunk(chunk)).toBe(chunk.replace(pattern, ""));
      }),
      { numRuns: 2_000 },
    );
  });

  it("reads a chunk of unclosed OSC openers once, not once per opener", () => {
    // A process in the runner writes its output chunks, and each is cleaned on the
    // main thread. The pattern ran from every opener to the end of the chunk and
    // back looking for a terminator: 120 KB of openers took over ten seconds.
    const chunk = `${ESCAPE}]`.repeat(60_000);
    const startedAt = performance.now();

    expect(sanitizeTerminalChunk(`${chunk}\n`)).toBe(`${chunk}\n`);
    expect(sanitizeTerminalChunk(`${chunk}${BELL}done\n`)).toBe("done\n");
    // Linear is well under a millisecond. Generous, so this is not timing-flaky.
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
