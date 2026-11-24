// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createCheck, tallyOf, type CheckResult } from "./check.ts";
import { checkCutLaw } from "./cutLaw.ts";
import { checkSeekVsPlay } from "./seekVsPlay.ts";
import {
  FILE_ROW,
  formatTable,
  rowsOf,
  tableHash,
  totalsLine,
  unreadableRow,
  type Row,
} from "./table.ts";
import { clip, compare, firstDifferencePath } from "./tally.ts";
import { recordTake } from "./testRecording.ts";

/** The rows a run on the generated take makes. */
function takeRows(): Row[] {
  const recording = recordTake();
  return [
    ...rowsOf("take", checkSeekVsPlay(recording, { seed: 1, tickMs: 50, everyMs: 200 })),
    ...rowsOf("take", checkCutLaw(recording, { cuts: 3, seed: 1, everyMs: 200 })),
  ];
}

describe("the rows", () => {
  it("has one row per check and track, the pointer and captions outside the law", () => {
    const rows = takeRows();
    expect(rows.map((row) => `${row.check}/${row.track}/${row.scope}`)).toEqual([
      "seek vs play/editor/in law",
      "seek vs play/workspace/in law",
      "seek vs play/runtime/in law",
      "seek vs play/chat/in law",
      "seek vs play/whiteboard/in law",
      "seek vs play/slides/in law",
      "seek vs play/preview/in law",
      "cut law/editor/in law",
      "cut law/workspace/in law",
      "cut law/runtime/in law",
      "cut law/chat/in law",
      "cut law/whiteboard/in law",
      "cut law/slides/in law",
      "cut law/preview/in law",
      "cut law/pointer/outside",
      "cut law/captions/outside",
    ]);
    expect(rows.filter((row) => row.checks === 0)).toEqual([]);
  });

  it("shows the first difference's time, where, both values and the cut", () => {
    const result = createCheck("cut law", [{ track: "runtime", scope: "in law" }]);
    const tally = tallyOf(result, "runtime");
    compare(tally, 10, { status: "ready" }, { status: "ready" });
    compare(tally, 20.0000001, { status: "ready" }, { status: "busy" }, "cut 5-9");
    compare(tally, 30, { status: "a" }, { status: "b" });
    const [row] = rowsOf("lesson", result);
    expect(row).toMatchObject({ checks: 3, diffs: 2, odd: 0 });
    expect(row.first).toBe('t=20 status: "ready" vs "busy" (cut 5-9)');
  });

  it("puts a file's own errors in their own row as odd, never as a difference", () => {
    const result: CheckResult = {
      ...createCheck("seek vs play", [{ track: "editor", scope: "in law" }]),
      odd: { count: 4, first: "content edit delta is malformed" },
    };
    expect(rowsOf("lesson", result).at(-1)).toEqual({
      recording: "lesson",
      check: "seek vs play",
      track: FILE_ROW,
      scope: "",
      checks: 0,
      diffs: 0,
      odd: 4,
      first: "odd: content edit delta is malformed",
    });
    expect(unreadableRow("broken", "Invalid recording format")).toMatchObject({
      diffs: 0,
      odd: 1,
    });
  });

  it("counts a check that stopped as one difference, so a person looks at it", () => {
    const result = { ...createCheck("cut law", []), stopped: "No branch takes TICK in ended" };
    expect(rowsOf("lesson", result)).toEqual([
      expect.objectContaining({
        track: FILE_ROW,
        diffs: 1,
        first: "stopped: No branch takes TICK in ended",
      }),
    ]);
  });

  it("totals the rows, split by whether the law covers them", () => {
    const rows: Row[] = [
      { ...unreadableRow("a", "x") },
      {
        recording: "b",
        check: "c",
        track: "editor",
        scope: "in law",
        checks: 5,
        diffs: 2,
        odd: 0,
        first: "",
      },
      {
        recording: "b",
        check: "c",
        track: "pointer",
        scope: "outside",
        checks: 5,
        diffs: 3,
        odd: 0,
        first: "",
      },
    ];
    expect(totalsLine(rows)).toBe(
      `total: 2 recordings, 10 checks, 2 differences in law, 3 outside the law, 1 odd file, hash ${tableHash(rows)}`,
    );
  });

  it("formats aligned columns under a header", () => {
    const lines = formatTable(takeRows().slice(0, 2)).split("\n");
    expect(lines[0]).toMatch(
      /^recording\s+check\s+track\s+law\s+checks\s+diffs\s+odd file\s+first difference$/,
    );
    expect(lines).toHaveLength(3);
    expect(lines[1].indexOf("seek vs play")).toBe(lines[0].indexOf("check"));
  });
});

describe("the table hash", () => {
  it("is the same for two runs that found the same", () => {
    expect(tableHash(takeRows())).toBe(tableHash(takeRows()));
    expect(tableHash(takeRows())).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes when any count or the first difference changes", () => {
    const rows = takeRows();
    const hash = tableHash(rows);
    const changed = (patch: Partial<Row>) =>
      tableHash(rows.map((row, index) => (index === 3 ? { ...row, ...patch } : row)));
    expect(changed({ diffs: rows[3].diffs + 1 })).not.toBe(hash);
    expect(changed({ checks: rows[3].checks + 1 })).not.toBe(hash);
    expect(changed({ odd: 1 })).not.toBe(hash);
    expect(changed({ first: "t=1: 1 vs 2" })).not.toBe(hash);
    expect(tableHash(rows.slice(1))).not.toBe(hash);
  });
});

describe("comparing what is shown", () => {
  it("ignores key order and keys that are not set, not array order", () => {
    expect(firstDifferencePath({ a: 1, b: undefined }, { a: 1 })).toBeNull();
    expect(firstDifferencePath({ a: 1, b: 2 }, { b: 2, a: 1 })).toBeNull();
    expect(firstDifferencePath([1, 2], [2, 1])).toEqual(["0"]);
    expect(firstDifferencePath({ files: { "a.css": "x" } }, { files: { "a.css": "y" } })).toEqual([
      "files",
      "a.css",
    ]);
  });

  it("keeps a file path with dots as one key when it reads the values back", () => {
    const tally = { checks: 0, diffs: 0, first: null };
    compare(tally, 1, { files: { "a.css": "x" } }, { files: { "a.css": "y" } });
    expect(tally.first).toEqual({ time: 1, path: "files.a.css", a: '"x"', b: '"y"' });
  });

  it("cuts a long value short", () => {
    expect(clip("x".repeat(200), 10)).toBe(`"xxxxxxxx…`);
    expect(clip(undefined)).toBe("undefined");
  });
});
