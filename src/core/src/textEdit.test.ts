import { describe, expect, it } from "vite-plus/test";
import {
  applyTextEditChanges,
  applyTextEditEvent,
  prepareTextEditChanges,
  prepareTextEditEvent,
  type TextEditEvent,
} from "./textEdit";

function event(before: string, after: string, changes: TextEditEvent["changes"]): TextEditEvent {
  return {
    fileId: "src/App.tsx",
    path: "src/App.tsx",
    beforeVersion: 7,
    afterVersion: 8,
    beforeLength: before.length,
    afterLength: after.length,
    changes,
  };
}

describe("TextEditEvent", () => {
  it("applies insertions, deletions, and replacements from Monaco offsets", () => {
    expect(
      applyTextEditEvent(
        "hello",
        event("hello", "hello!", [
          {
            offset: 5,
            deleteLength: 0,
            text: "!",
          },
        ]),
      ),
    ).toBe("hello!");
    expect(
      applyTextEditEvent(
        "hello",
        event("hello", "heo", [
          {
            offset: 2,
            deleteLength: 2,
            text: "",
          },
        ]),
      ),
    ).toBe("heo");
    expect(
      applyTextEditEvent(
        "hello",
        event("hello", "hullo", [
          {
            offset: 1,
            deleteLength: 1,
            text: "u",
          },
        ]),
      ),
    ).toBe("hullo");
  });

  it("preserves multi-cursor and equal-offset insertion ordering", () => {
    const multiCursor = event("abcd", "aXbcYd", [
      { offset: 1, deleteLength: 0, text: "X" },
      { offset: 3, deleteLength: 0, text: "Y" },
    ]);
    expect(applyTextEditEvent("abcd", multiCursor)).toBe("aXbcYd");

    const sameOffset = event("ab", "aXYb", [
      { offset: 1, deleteLength: 0, text: "X" },
      { offset: 1, deleteLength: 0, text: "Y" },
    ]);
    expect(applyTextEditEvent("ab", sameOffset)).toBe("aXYb");
  });

  it("uses UTF-16 offsets like Monaco", () => {
    const before = "a😀b";
    const after = "a🎉b";
    expect(
      applyTextEditEvent(
        before,
        event(before, after, [{ offset: 1, deleteLength: 2, text: "🎉" }]),
      ),
    ).toBe(after);
  });

  it("rejects stale lengths, inconsistent results, and overlapping ranges", () => {
    const valid = event("abcdef", "aXdef", [{ offset: 1, deleteLength: 2, text: "X" }]);
    expect(prepareTextEditEvent(valid, 5)).toBeNull();
    expect(
      applyTextEditEvent("abcdef", { ...valid, afterLength: valid.afterLength + 1 }),
    ).toBeNull();
    expect(
      applyTextEditEvent(
        "abcdef",
        event("abcdef", "invalid", [
          { offset: 1, deleteLength: 3, text: "" },
          { offset: 2, deleteLength: 1, text: "" },
        ]),
      ),
    ).toBeNull();
  });

  it("validates and applies a bare change batch without an event identity", () => {
    const changes = [
      { offset: 1, deleteLength: 0, text: "X" },
      { offset: 3, deleteLength: 0, text: "Y" },
    ];
    expect(prepareTextEditChanges(changes, 4, 6)?.changes).toEqual([changes[1], changes[0]]);
    expect(applyTextEditChanges("abcd", changes, 6)).toBe("aXbcYd");

    // A wrong result length, an empty batch, a range past the end, overlap.
    expect(applyTextEditChanges("abcd", changes, 7)).toBeNull();
    expect(prepareTextEditChanges([], 4, 4)).toBeNull();
    expect(applyTextEditChanges("abcd", [{ offset: 3, deleteLength: 2, text: "" }], 2)).toBeNull();
    expect(
      applyTextEditChanges(
        "abcdef",
        [
          { offset: 1, deleteLength: 3, text: "" },
          { offset: 2, deleteLength: 1, text: "" },
        ],
        2,
      ),
    ).toBeNull();
  });

  it("checks the event identity and versions before its changes", () => {
    const valid = event("ab", "aXb", [{ offset: 1, deleteLength: 0, text: "X" }]);
    expect(applyTextEditEvent("ab", valid)).toBe("aXb");
    expect(applyTextEditEvent("ab", { ...valid, fileId: "" })).toBeNull();
    expect(applyTextEditEvent("ab", { ...valid, path: "" })).toBeNull();
    expect(applyTextEditEvent("ab", { ...valid, afterVersion: valid.beforeVersion })).toBeNull();
    expect(prepareTextEditEvent({ ...valid, beforeLength: 3 }, 2)).toBeNull();
    // The identity is the only difference from a bare batch.
    expect(applyTextEditChanges("ab", valid.changes, valid.afterLength)).toBe("aXb");
  });
});
