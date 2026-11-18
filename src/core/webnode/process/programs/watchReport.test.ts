// @vitest-environment node
// Node's watch-mode report protocol: the variable that asks for reports and
// the two messages, as lib/internal/watch_mode/files_watcher.js and
// lib/internal/worker.js spell them in Node v26.
import { describe, expect, it } from "vitest";
import {
  WATCH_REPORT_ENV,
  watchReportMessage,
  watchReportsIn,
  watchReportsWanted,
} from "./watchReport";

describe("the watch report protocol", () => {
  it("asks for reports with Node's variable", () => {
    expect(WATCH_REPORT_ENV).toEqual({ WATCH_REPORT_DEPENDENCIES: "1" });
    expect(watchReportsWanted({ PATH: "/bin", ...WATCH_REPORT_ENV })).toBe(true);
    expect(watchReportsWanted({ PATH: "/bin" })).toBe(false);
    // Node tests the variable's truthiness: empty is not asking.
    expect(watchReportsWanted({ WATCH_REPORT_DEPENDENCIES: "" })).toBe(false);
  });

  it("writes Node's messages: paths for require, URLs for import", () => {
    expect(watchReportMessage("require", ["/app/a b.js"])).toEqual({
      "watch:require": ["/app/a b.js"],
    });
    expect(watchReportMessage("import", ["file:///app/m.mjs"])).toEqual({
      "watch:import": ["file:///app/m.mjs"],
    });
  });

  it("reads the reports a message carries, and none from any other message", () => {
    expect(watchReportsIn({ "watch:require": ["/app/dep.js"] })).toEqual([
      { kind: "require", files: ["/app/dep.js"] },
    ]);
    // Both kinds in one message, beside a program's own fields; an empty list is still a report.
    expect(
      watchReportsIn({ "watch:import": ["file:///app/m.mjs"], "watch:require": [], other: 1 }),
    ).toEqual([
      { kind: "require", files: [] },
      { kind: "import", files: ["file:///app/m.mjs"] },
    ]);
    for (const message of [
      null,
      undefined,
      "watch:require",
      7,
      { "watch:require": "/app/dep.js" },
      { type: "dependency", path: "/app/dep.ts" },
    ]) {
      expect(watchReportsIn(message)).toEqual([]);
    }
  });

  it("round-trips: what is written is what is read", () => {
    for (const kind of ["require", "import"] as const) {
      expect(watchReportsIn(watchReportMessage(kind, ["x"]))).toEqual([{ kind, files: ["x"] }]);
    }
  });
});
