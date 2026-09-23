import { describe, expect, it } from "vite-plus/test";
import type * as monaco from "monaco-editor";
import { applyContentDiff } from "./editorDiff";

const isHighSurrogate = (charCode: number) => charCode >= 0xd800 && charCode <= 0xdbff;

interface UndoRecord {
  offset: number;
  insertedLength: number;
  removedText: string;
}

/**
 * A text model that applies edits the way Monaco's TextModel does: validateRange
 * moves an offset that sits right after a high surrogate to the pair boundary
 * (widening the range, or shifting a collapsed one left) but keeps the
 * replacement text as given, so a half pair in the text survives into the model.
 * `pushEditOperations` applies the same edits and also records them on the undo
 * stack, which `applyEdits` does not; `undo` replays the recorded offsets blindly,
 * as Monaco's edit stack does, and `setValue` clears the history.
 */
class FakeTextModel {
  widenedRanges = 0;
  private value: string;
  private undoStack: UndoRecord[][] = [];

  constructor(value: string) {
    this.value = value;
  }

  get undoableEdits(): number {
    return this.undoStack.length;
  }

  getValue(): string {
    return this.value;
  }

  setValue(value: string): void {
    this.value = value;
    this.undoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  undo(): void {
    const records = this.undoStack.pop() ?? [];
    for (const { offset, insertedLength, removedText } of records.reverse()) {
      this.value =
        this.value.slice(0, offset) + removedText + this.value.slice(offset + insertedLength);
    }
  }

  getPositionAt(offset: number): monaco.IPosition {
    const lines = this.value.slice(0, offset).split("\n");
    return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
  }

  pushEditOperations(
    _selections: unknown,
    operations: monaco.editor.IIdentifiedSingleEditOperation[],
  ): null {
    this.undoStack.push(operations.map((operation) => this.applyEdit(operation)));
    return null;
  }

  applyEdits(operations: readonly monaco.editor.IIdentifiedSingleEditOperation[]): void {
    for (const operation of operations) {
      this.applyEdit(operation);
    }
  }

  private applyEdit({ range, text }: monaco.editor.IIdentifiedSingleEditOperation): UndoRecord {
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

    const removedText = this.value.slice(start, end);
    this.value = this.value.slice(0, start) + (text ?? "") + this.value.slice(end);
    return { offset: start, insertedLength: (text ?? "").length, removedText };
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

  // The viewer may type into an ended lesson's playback model. applyEdits leaves that
  // history in place, and undo applies its offsets blindly, so after a seek rewrote
  // the content, Ctrl+Z spliced the viewer's old text into the replayed code.
  it("drops the viewer's own undo history when replay rewrites the content", () => {
    const model = new FakeTextModel("let total = 0;\nreturn total;");
    model.pushEditOperations(
      [],
      [
        {
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 },
          text: "var",
        },
      ],
    );
    const replayed = "const sum = items.reduce(add, 0);\nreturn sum;";

    applyContentDiff(createEditor(model), replayed);
    model.undo();

    expect(model.getValue()).toBe(replayed);
    expect(model.canUndo()).toBe(false);
  });
});
