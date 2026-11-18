// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PmError } from "./errors";
import { Reporter, type Sink } from "./output";

/** A terminal that keeps what was written to it, stdout and stderr interleaved as a screen shows them. */
function terminal(): Sink & { screen(): string } {
  let written = "";
  return {
    isTTY: true,
    columns: 80,
    write(_fd, text) {
      written += text;
    },
    flush: () => Promise.resolve(),
    lostReader: false,
    lostWrites: 0,
    screen: () => written,
  };
}

const COUNTS = { resolved: 3, reused: 0, downloaded: 2, added: 0 };

describe("Reporter on a terminal", () => {
  it("starts an error on a line of its own after a progress line it was redrawing", () => {
    const sink = terminal();
    const reporter = new Reporter("pnpm", sink);
    reporter.progress(COUNTS);
    reporter.error(new PmError("EFETCH", "GET https://registry.example/x: request failed"));
    const lines = sink.screen().split("\n");
    expect(lines[0]).toMatch(/Progress: resolved 3, reused 0, downloaded 2, added 0$/);
    expect(lines[1]).toMatch(
      /^ ERR_PNPM_\S+ {2}GET https:\/\/registry\.example\/x: request failed$/,
    );
  });

  it("starts a warning on a line of its own, and draws the progress again below it", () => {
    const sink = terminal();
    const reporter = new Reporter("pnpm", sink);
    reporter.progress(COUNTS);
    reporter.warn("deprecated something@1.0.0");
    reporter.progressDone({ ...COUNTS, added: 3 });
    const lines = sink.screen().split("\n");
    expect(lines[1]).toBe(" WARN  deprecated something@1.0.0");
    expect(lines[2]).toBe("Progress: resolved 3, reused 0, downloaded 2, added 3, done");
  });

  it("adds no empty line when no progress line is open", () => {
    const sink = terminal();
    const reporter = new Reporter("pnpm", sink);
    reporter.warn("first");
    reporter.error(new PmError("EOTHER", "second"));
    expect(sink.screen().startsWith(" WARN  first\n ERR_PNPM")).toBe(true);
  });
});
