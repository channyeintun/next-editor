import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { diffTerminalOutput } from "../core/src/runtimeTrack";
import { findSlidWindowOverlap } from "./terminalOutputOverlap";

const WINDOW = 6000;

/** A log of numbered lines, so no stretch of it repeats. */
function numberedLog(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `line ${index} of the dev server log\n`).join(
    "",
  );
}

describe("findSlidWindowOverlap", () => {
  it("finds where the new text starts once a capped log slides", () => {
    const log = numberedLog(400);
    const previous = log.slice(0, 7000).slice(-WINDOW);
    const next = log.slice(0, 7300).slice(-WINDOW);

    const overlap = findSlidWindowOverlap(previous, next);

    expect(overlap).toBe(WINDOW - 300);
    expect(next.slice(overlap)).toBe(log.slice(7000, 7300));
  });

  it("finds nothing in text that does not continue the written text", () => {
    const log = numberedLog(400);

    expect(findSlidWindowOverlap(log.slice(0, WINDOW), log.slice(9000, 9000 + WINDOW))).toBe(-1);
    expect(findSlidWindowOverlap(log.slice(0, WINDOW), "Waiting for runner output...")).toBe(-1);
  });

  it("leaves text shorter than its anchor to a rewrite", () => {
    expect(findSlidWindowOverlap("short output", "output and more")).toBe(-1);
  });

  it("agrees with the recording's longest overlap whenever it finds one", () => {
    // A three-character alphabet makes the anchor match in many places.
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom("a", "b", "\n"), minLength: 600, maxLength: 1500 }),
        fc.integer({ min: 300, max: 600 }),
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 0, max: 300 }),
        (log, window, dropped, appended) => {
          const end = Math.min(log.length - appended, window + dropped);
          const previous = log.slice(Math.max(0, end - window), end);
          const next = log.slice(Math.max(0, end + appended - window), end + appended);
          const overlap = findSlidWindowOverlap(previous, next);

          if (overlap === -1) {
            return;
          }

          expect(previous.endsWith(next.slice(0, overlap))).toBe(true);
          expect(overlap).toBe(previous.length - diffTerminalOutput(previous, next).drop);
        },
      ),
    );
  });

  it("finds the true overlap in output that does not repeat itself", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "grapheme-ascii", minLength: 2000, maxLength: 3000 }),
        fc.integer({ min: 300, max: 1000 }),
        fc.integer({ min: 1, max: 400 }),
        (log, window, appended) => {
          fc.pre(new Set(log).size > 40);
          const end = log.length - appended;
          const previous = log.slice(end - window, end);
          const next = log.slice(end + appended - window, end + appended);

          expect(findSlidWindowOverlap(previous, next)).toBe(
            window - appended < 256 ? -1 : window - appended,
          );
        },
      ),
    );
  });
});
