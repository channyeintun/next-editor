import type * as Monaco from "monaco-editor";
import { describe, expect, it, vi } from "vitest";
import {
  CollaborationCursorLabelManager,
  type CollaborationCursorLabel,
} from "./collaborationCursorLabels";

function createEditor() {
  const addContentWidget = vi.fn<(widget: Monaco.editor.IContentWidget) => void>();
  const layoutContentWidget = vi.fn<(widget: Monaco.editor.IContentWidget) => void>();
  const removeContentWidget = vi.fn<(widget: Monaco.editor.IContentWidget) => void>();
  const editor = {
    addContentWidget,
    layoutContentWidget,
    removeContentWidget,
  } as unknown as Monaco.editor.IStandaloneCodeEditor;

  return { addContentWidget, editor, layoutContentWidget, removeContentWidget };
}

function cursorLabel(overrides: Partial<CollaborationCursorLabel> = {}) {
  return {
    id: "actor-1:session-1",
    name: "Ada Lovelace",
    colorIndex: 2,
    position: { lineNumber: 4, column: 7 },
    ...overrides,
  } satisfies CollaborationCursorLabel;
}

describe("CollaborationCursorLabelManager", () => {
  it("creates a persistent name label at a remote cursor position", () => {
    const manager = new CollaborationCursorLabelManager();
    const { addContentWidget, editor } = createEditor();

    manager.reconcile(
      editor,
      [
        cursorLabel(),
        cursorLabel({ id: "actor-2:session-2", name: "Grace Hopper", colorIndex: 4 }),
      ],
      [1, 2],
    );

    expect(addContentWidget).toHaveBeenCalledTimes(2);
    const widget = addContentWidget.mock.calls[0][0];
    const secondWidget = addContentWidget.mock.calls[1][0];
    expect(widget.getDomNode()).toHaveTextContent("Ada Lovelace");
    expect(secondWidget.getDomNode()).toHaveTextContent("Grace Hopper");
    expect(widget.getDomNode()).toHaveClass("collaboration-cursor-label", "collaboration-color-2");
    expect(widget.getPosition()).toEqual({
      position: { lineNumber: 4, column: 7 },
      preference: [1, 2],
    });
  });

  it("updates existing labels and removes cursors that leave the file", () => {
    const manager = new CollaborationCursorLabelManager();
    const { addContentWidget, editor, layoutContentWidget, removeContentWidget } = createEditor();

    manager.reconcile(editor, [cursorLabel()], [1, 2]);
    const widget = addContentWidget.mock.calls[0][0];
    manager.reconcile(
      editor,
      [
        cursorLabel({
          name: "ada",
          colorIndex: 5,
          position: { lineNumber: 8, column: 3 },
        }),
      ],
      [2, 1],
    );

    expect(addContentWidget).toHaveBeenCalledOnce();
    expect(layoutContentWidget).toHaveBeenCalledWith(widget);
    expect(widget.getDomNode()).toHaveTextContent("ada");
    expect(widget.getDomNode()).toHaveClass("collaboration-color-5");
    expect(widget.getPosition()).toEqual({
      position: { lineNumber: 8, column: 3 },
      preference: [2, 1],
    });

    manager.reconcile(editor, [], [1, 2]);
    expect(removeContentWidget).toHaveBeenCalledWith(widget);
  });
});
