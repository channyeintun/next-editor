import { describe, expect, it } from "vite-plus/test";
import { applyTextEditEvent, prepareTextEditEvent, type TextEditEvent } from "./textEdit";

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
});
