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
});
