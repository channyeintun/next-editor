import { describe, expect, it } from "vitest";
import { formatDiagnosticLine } from "../../src/ui/diagnosticsFormat";

// Log privacy audit (plan §17.3): the formatter only accepts primitive
// fields and the emitted lines carry IDs/counts/hashes — never document
// text. This test pins the shape so a leaky call site fails review.
describe("diagnostics formatting", () => {
  it("formats structured fields only", () => {
    const line = formatDiagnosticLine("info", "recorder.state", {
      state: "recording",
      sessionId: "abc-123",
      events: 42,
      durable: true,
    });
    expect(line).toMatch(
      /\[info\] recorder\.state state=recording sessionId=abc-123 events=42 durable=true$/,
    );
  });

  it("keeps codes and fields on one line without interpolating objects", () => {
    const line = formatDiagnosticLine("debug", "journal.sync", {
      lastDurableSeq: 10,
      queuedBytes: 0,
    });
    expect(line).not.toContain("[object");
    expect(line.split("\n")).toHaveLength(1);
  });
});
