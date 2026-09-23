import { describe, expect, it } from "vite-plus/test";
import type * as monaco from "monaco-editor";
import { applyContentDiff } from "./editorDiff";

const isHighSurrogate = (charCode: number) => charCode >= 0xd800 && charCode <= 0xdbff;

/**
 * A text model that applies edits the way Monaco's TextModel does: validateRange
 * moves an offset that sits right after a high surrogate to the pair boundary
 * (widening the range, or shifting a collapsed one left) but keeps the
 * replacement text as given, so a half pair in the text survives into the model.
 * `pushEditOperations` applies the same edits and also puts them on the undo
 * stack, which `applyEdits` does not.
 */
class FakeTextModel {
  widenedRanges = 0;
  undoableEdits = 0;
  private value: string;

  constructor(value: string) {
    this.value = value;
  }

  getValue(): string {
    return this.value;
  }

  setValue(value: string): void {
    this.value = value;
  }

  getPositionAt(offset: number): monaco.IPosition {
    const lines = this.value.slice(0, offset).split("\n");
    return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
  }

  pushEditOperations(
    _selections: unknown,
    operations: monaco.editor.IIdentifiedSingleEditOperation[],
  ): null {
    this.undoableEdits += operations.length;
    this.applyEdits(operations);
    return null;
  }

  applyEdits(operations: readonly monaco.editor.IIdentifiedSingleEditOperation[]): void {
    for (const { range, text } of operations) {
      let start = this.getOffsetAt(range.startLineNumber, range.startColumn);
      let end = this.getOffsetAt(range.endLineNumber, range.endColumn);
      const startInsidePair = start > 0 && isHighSurrogate(this.value.charCodeAt(start - 1));
      const endInsidePair =
        end > 0 && end < this.value.length && isHighSurrogate(this.value.charCodeAt(end - 1));

      if (startInsidePair || endInsidePair) {
        this.widenedRanges += 1;
        if (start === end) {
          start -= 1;
          end -= 1;
        } else {
          if (startInsidePair) start -= 1;
          if (endInsidePair) end += 1;
        }
      }

      this.value = this.value.slice(0, start) + (text ?? "") + this.value.slice(end);
    }
  }

  private getOffsetAt(lineNumber: number, column: number): number {
    const lines = this.value.split("\n");
    let offset = 0;
    for (let index = 0; index < lineNumber - 1; index += 1) {
      offset += lines[index].length + 1;
    }
    return offset + column - 1;
  }
}

const createEditor = (model: FakeTextModel) =>
  ({ getModel: () => model }) as unknown as monaco.editor.IStandaloneCodeEditor;

describe("applyContentDiff", () => {
  it("replays edits to astral characters without leaving half a surrogate pair", () => {
    const cases: Array<[string, string]> = [
      ["😀", "😁"],
      ["x😁", "x😀😁"],
      ["a😀b", "a😃b"],
      ["x😀😁", "x😁"],
      ["a\u{20000}b", "a\u{10000}b"],
      ["const s = '🚀';\nconsole.log(s);", "const s = '🔥';\nconsole.log(s);"],
      ["hello world", "hello there world"],
    ];

    for (const [current, target] of cases) {
      const model = new FakeTextModel(current);

      expect(applyContentDiff(createEditor(model), target, current)).toBe(true);
      expect(model.getValue()).toBe(target);
      expect(model.widenedRanges).toBe(0);
    }
  });

  // Replayed content is the recording's history, not the viewer's edits. On the undo
  // stack it merged into one element, so Ctrl+Z at the end of a lesson rewound the
  // editor to the lesson's opening code.
  it("keeps replayed edits off the model's undo stack", () => {
    const model = new FakeTextModel("const a = 1;");

    applyContentDiff(createEditor(model), "const a = 2;", "const a = 1;");
    applyContentDiff(createEditor(model), "const a = 23;", "const a = 2;");

    expect(model.getValue()).toBe("const a = 23;");
    expect(model.undoableEdits).toBe(0);
  });
});
