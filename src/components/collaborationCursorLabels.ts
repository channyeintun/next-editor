import type * as Monaco from "monaco-editor";

export interface CollaborationCursorLabel {
  id: string;
  name: string;
  colorIndex: number;
  position: Monaco.IPosition;
}

interface CollaborationCursorLabelWidget {
  editor: Monaco.editor.IStandaloneCodeEditor;
  domNode: HTMLDivElement;
  state: {
    position: Monaco.IPosition;
    preferences: Monaco.editor.ContentWidgetPositionPreference[];
  };
  widget: Monaco.editor.IContentWidget;
}

function updateCursorLabelElement(
  domNode: HTMLDivElement,
  label: Pick<CollaborationCursorLabel, "name" | "colorIndex">,
) {
  domNode.className = `collaboration-cursor-label collaboration-color-${label.colorIndex}`;
  domNode.textContent = label.name;
  domNode.title = label.name;
}

/** Keeps Monaco name labels attached to the matching remote cursor positions. */
export class CollaborationCursorLabelManager {
  private readonly widgets = new Map<string, CollaborationCursorLabelWidget>();

  reconcile(
    editor: Monaco.editor.IStandaloneCodeEditor,
    labels: CollaborationCursorLabel[],
    preferences: Monaco.editor.ContentWidgetPositionPreference[],
  ) {
    if (Array.from(this.widgets.values()).some((entry) => entry.editor !== editor)) {
      this.clear();
    }

    const currentIds = new Set<string>();

    for (const label of labels) {
      currentIds.add(label.id);
      const existing = this.widgets.get(label.id);

      if (existing) {
        existing.state.position = label.position;
        existing.state.preferences = preferences.slice();
        updateCursorLabelElement(existing.domNode, label);
        editor.layoutContentWidget(existing.widget);
        continue;
      }

      const domNode = document.createElement("div");
      domNode.setAttribute("aria-hidden", "true");
      updateCursorLabelElement(domNode, label);
      const state = {
        position: label.position,
        preferences: preferences.slice(),
      };
      const widget: Monaco.editor.IContentWidget = {
        allowEditorOverflow: true,
        suppressMouseDown: true,
        getId: () => `next-editor.collaboration-cursor-label:${label.id}`,
        getDomNode: () => domNode,
        getPosition: () => ({
          position: state.position,
          preference: state.preferences,
        }),
      };

      this.widgets.set(label.id, { editor, domNode, state, widget });
      editor.addContentWidget(widget);
    }

    for (const [id, entry] of this.widgets) {
      if (currentIds.has(id)) continue;
      this.remove(id, entry);
    }
  }

  clear() {
    for (const [id, entry] of this.widgets) {
      this.remove(id, entry);
    }
  }

  private remove(id: string, entry: CollaborationCursorLabelWidget) {
    try {
      entry.editor.removeContentWidget(entry.widget);
    } catch {
      // Monaco may dispose the editor before the parent collaboration effect cleans up.
    }
    this.widgets.delete(id);
  }
}
