// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  countReplayErrorsAsDifference,
  createCheck,
  markNoEvents,
  tallyOf,
  type CheckResult,
} from "./check.ts";
import { checkCutLaw } from "./cutLaw.ts";
import { checkSeekVsPlay } from "./seekVsPlay.ts";
import {
  FILE_ROW,
  formatTable,
  NO_EVENTS,
  rowsOf,
  tableHash,
  totalsLine,
  unreadableRow,
  type Row,
} from "./table.ts";
import { clip, compare, digestOf, firstDifferencePath, stableText } from "./tally.ts";
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
      "cut law/(edit)/in law",
      "cut law/pointer/outside",
      "cut law/captions/outside",
    ]);
    // The take has no chat or preview: those rows say so instead of counting checks.
    expect(
      rows.filter((row) => row.checks === 0).map((row) => `${row.check}/${row.track}`),
    ).toEqual(["seek vs play/chat", "seek vs play/preview", "cut law/chat", "cut law/preview"]);
    expect(rows.filter((row) => row.first === NO_EVENTS).every((row) => row.checks === 0)).toBe(
      true,
    );
  });

  it("shows the first difference's time, where, both values and the cut", () => {
    const result = createCheck("cut law", [{ track: "runtime", scope: "in law" }]);
    const tally = tallyOf(result, "runtime");
    compare(tally, 10, { status: "ready" }, { status: "ready" });
    compare(tally, 20.0000001, { status: "ready" }, { status: "busy" }, "cut 5-9");
    compare(tally, 30, { status: "a" }, { status: "b" });
    const [row] = rowsOf("lesson", result);
    expect(row).toMatchObject({ checks: 3, diffs: 2, errors: 0 });
    expect(row.first).toBe('t=20 status: "ready" vs "busy" (cut 5-9)');
  });

  it("puts errors replaying the published file in their own column, not as a difference", () => {
    const result: CheckResult = {
      ...createCheck("seek vs play", [{ track: "editor", scope: "in law" }]),
      errors: { count: 4, first: "content edit delta is malformed" },
    };
    expect(rowsOf("lesson", result).at(-1)).toEqual({
      recording: "lesson",
      check: "seek vs play",
      track: FILE_ROW,
      scope: "",
      checks: 0,
      diffs: 0,
      errors: 4,
      first: "error: content edit delta is malformed",
    });
    expect(unreadableRow("broken", "Invalid recording format")).toMatchObject({
      diffs: 0,
      errors: 1,
      first: "error: Invalid recording format",
    });
  });

  it("shows a track with no events as such, with no checks", () => {
    const result = createCheck("seek vs play", [
      { track: "chat", scope: "in law" },
      { track: "editor", scope: "in law" },
    ]);
    markNoEvents(result, "chat");
    compare(tallyOf(result, "editor"), 1, "a", "a");
    expect(rowsOf("lesson", result)).toMatchObject([
      { track: "chat", checks: 0, diffs: 0, first: NO_EVENTS },
      { track: "editor", checks: 1, first: "" },
    ]);
  });

  it("shows an error replaying a cut's output as the difference it is", () => {
    const result = createCheck("cut law", [{ track: "(edit)", scope: "in law" }]);
    countReplayErrorsAsDifference(tallyOf(result, "(edit)"), ["bad base"], 12, "cut 1-2");
    countReplayErrorsAsDifference(tallyOf(result, "(edit)"), [], 13, "cut 1-2");
    const rows = rowsOf("lesson", result);
    expect(rows).toEqual([
      expect.objectContaining({
        scope: "in law",
        checks: 2,
        diffs: 1,
        errors: 0,
        first: 't=12: replay error "bad base" (cut 1-2)',
      }),
    ]);
    expect(totalsLine(rows)).toMatch(/1 differences in law, 0 outside the law, 0 errors/);
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
        errors: 0,
        first: "",
      },
      {
        recording: "b",
        check: "c",
        track: "pointer",
        scope: "outside",
        checks: 5,
        diffs: 3,
        errors: 0,
        first: "",
      },
    ];
    expect(totalsLine(rows)).toBe(
      `total: 2 recordings, 10 checks, 2 differences in law, 3 outside the law, 1 errors, hash ${tableHash(rows)}`,
    );
  });

  it("formats aligned columns under a header", () => {
    const lines = formatTable(takeRows().slice(0, 2)).split("\n");
    expect(lines[0]).toMatch(
      /^recording\s+check\s+track\s+law\s+checks\s+diffs\s+errors\s+first difference$/,
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
    expect(changed({ errors: 1 })).not.toBe(hash);
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

  it("digests two values alike exactly when it finds them equal", () => {
    const pairs: Array<[unknown, unknown]> = [
      [{ a: 1, b: undefined }, { a: 1 }],
      [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
      [
        [1, 2],
        [2, 1],
      ],
      [[1], [1, undefined]],
      [{ a: "1" }, { a: 1 }],
      [{ a: null }, { a: undefined }],
      [0, -0],
      [Number.NaN, Number.NaN],
      [[], {}],
      [{ files: { "a.b": "x" } }, { files: { a: { b: "x" } } }],
      [undefined, undefined],
    ];
    for (const [a, b] of pairs) {
      const equal = firstDifferencePath(a, b) === null;
      expect({ a, b, alike: digestOf(a) === digestOf(b) }).toEqual({ a, b, alike: equal });
    }
    expect(stableText({ b: [1], a: "x" })).toBe('{"a":"x","b":[1|"0":n1]}');
  });

  it("cuts a long value short", () => {
    expect(clip("x".repeat(200), 10)).toBe(`"xxxxxxxx…`);
    expect(clip(undefined)).toBe("undefined");
  });
});
