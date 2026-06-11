export class Selection {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  selectionStartLineNumber: number;
  selectionStartColumn: number;
  positionLineNumber: number;
  positionColumn: number;

  constructor(
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number,
  ) {
    this.startLineNumber = startLineNumber;
    this.startColumn = startColumn;
    this.endLineNumber = endLineNumber;
    this.endColumn = endColumn;
    this.selectionStartLineNumber = startLineNumber;
    this.selectionStartColumn = startColumn;
    this.positionLineNumber = endLineNumber;
    this.positionColumn = endColumn;
  }
}

export const KeyCode = {
  LeftArrow: 1,
  RightArrow: 2,
  UpArrow: 3,
  DownArrow: 4,
  PageUp: 5,
  PageDown: 6,
  Home: 7,
  End: 8,
  Shift: 9,
  Ctrl: 10,
  Alt: 11,
  Meta: 12,
  CapsLock: 13,
  Escape: 14,
  F1: 15,
  F2: 16,
  F3: 17,
  F4: 18,
  F5: 19,
  F6: 20,
  F7: 21,
  F8: 22,
  F9: 23,
  F10: 24,
  F11: 25,
  F12: 26,
} as const;

export const editor = {};
