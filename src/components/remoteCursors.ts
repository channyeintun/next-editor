import type * as Y from "yjs";
import type { ResolvedMonacoAwarenessSelection } from "../collaboration/monacoAwareness";
import { collaborationParticipantKey } from "../collaboration/participantKey";
import type { CollaborationPresenceState } from "../collaboration/protocol";
import { resolveCollaborationCursor } from "../collaboration/relativePosition";
import type { EditorSelection } from "../core/src/types";
import { monaco } from "../monaco";
import type { CollaborationCursorLabel } from "./collaborationCursorLabels";
import {
  collaboratorColor,
  collaboratorColorIndex,
  collaboratorDisplayName,
  collaboratorSelectionColor,
} from "./collaboratorAppearance";

// Pure helpers behind how CodeEditor shows other participants' cursors in
// Monaco, and how it records them.

/**
 * Monaco renders `hoverMessage.value` as Markdown. `username` is charset-safe,
 * but `name` comes straight from the Google ID token's `name` claim with only a
 * length check, so a peer whose account name contains Markdown could render a
 * link or a remote image inside another participant's editor hover — phishing
 * plus an IP beacon that fires on hovering their cursor. Escaping the syntax
 * characters keeps the name readable while making it inert.
 */
function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, "\\$&");
}

/** What these helpers need of CodeEditor's y-monaco binding. */
export interface YMonacoBindingTarget {
  editor: unknown;
  model: unknown;
  text: Y.Text;
}

/** Whether `binding` is y-monaco's binding of `model` in `editor`. */
export function yMonacoBindsModel<Binding extends YMonacoBindingTarget>(
  binding: Binding | null,
  editor: unknown,
  model: unknown,
): binding is Binding {
  return binding !== null && binding.editor === editor && binding.model === model;
}

/**
 * The shared text the open file's awareness selections are resolved against:
 * the one y-monaco binds to `model` in `editor`, which then draws those
 * selections itself, or else the room's text for the file.
 */
export function resolveAwarenessText(
  binding: YMonacoBindingTarget | null,
  editor: unknown,
  model: unknown,
  roomText: () => Y.Text | undefined,
): { text: Y.Text | undefined; yMonacoRendersSelections: boolean } {
  if (yMonacoBindsModel(binding, editor, model)) {
    return { text: binding.text, yMonacoRendersSelections: true };
  }
  return { text: roomText(), yMonacoRendersSelections: false };
}

/** Another participant's selection in the open file, as offsets into it. */
export type RemoteEditorSelection = {
  /** The participant's collaborationParticipantKey. */
  key: string;
  participant: CollaborationPresenceState;
  anchorOffset: number;
  headOffset: number;
} & (
  | {
      /** A standard y-monaco awareness selection, from this awareness client. */
      fromAwareness: true;
      clientId: number;
    }
  | {
      /** The participant's collaboration cursor. */
      fromAwareness: false;
    }
);

/**
 * Every other participant's selection in the open file, the one list
 * CodeEditor both draws and records: the awareness selections first, then
 * the collaboration cursor of each participant who has none of those, is not
 * this tab's own and points into the file (`activeFileNodeId`).
 */
export function collectRemoteEditorSelections({
  awarenessSelections,
  doc,
  participants,
  ownParticipantKey,
  activeFileNodeId,
}: {
  awarenessSelections: readonly ResolvedMonacoAwarenessSelection[];
  doc: Y.Doc;
  participants: readonly CollaborationPresenceState[];
  ownParticipantKey: string | null;
  activeFileNodeId: string | undefined;
}): RemoteEditorSelection[] {
  const selections: RemoteEditorSelection[] = awarenessSelections.map((selection) => ({
    key: collaborationParticipantKey(selection.participant),
    participant: selection.participant,
    anchorOffset: selection.anchorOffset,
    headOffset: selection.headOffset,
    fromAwareness: true,
    clientId: selection.clientId,
  }));
  const awarenessKeys = new Set(selections.map((selection) => selection.key));
  for (const participant of participants) {
    const key = collaborationParticipantKey(participant);
    if (
      awarenessKeys.has(key) ||
      key === ownParticipantKey ||
      !participant.cursor ||
      participant.cursor.fileNodeId !== activeFileNodeId
    ) {
      continue;
    }
    const cursor = resolveCollaborationCursor(doc, participant.cursor);
    if (!cursor) continue;
    selections.push({ key, participant, ...cursor, fromAwareness: false });
  }
  return selections;
}

/** All these helpers need of a Monaco text model. */
type PositionedModel = { getPositionAt(offset: number): monaco.IPosition };

/** A remote participant's selection, as positions in one Monaco model. */
export interface RemoteSelection {
  /** Where the selection started. */
  anchor: monaco.IPosition;
  /** Where the caret is. */
  head: monaco.IPosition;
  /** The earlier of anchor and head. */
  start: monaco.IPosition;
  /** The later of anchor and head. */
  end: monaco.IPosition;
  /** Anchor and head are different offsets, so some text is selected. */
  hasSelectedText: boolean;
}

/** Places a remote selection's anchor and head offsets in `model`. */
export function resolveRemoteSelection(
  model: PositionedModel,
  anchorOffset: number,
  headOffset: number,
): RemoteSelection {
  const anchor = model.getPositionAt(anchorOffset);
  const head = model.getPositionAt(headOffset);
  const startsBeforeHead = anchorOffset <= headOffset;
  return {
    anchor,
    head,
    start: startsBeforeHead ? anchor : head,
    end: startsBeforeHead ? head : anchor,
    hasSelectedText: anchorOffset !== headOffset,
  };
}

/**
 * The decorations CodeEditor draws for a remote selection: a highlight over
 * the selected text, if there is any, then a caret at the head. Both use the
 * participant's colour and show their name on hover.
 */
export function remoteSelectionDecorations(
  { head, start, end, hasSelectedText }: RemoteSelection,
  colorIndex: number,
  participantName: string,
): monaco.editor.IModelDeltaDecoration[] {
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  if (hasSelectedText) {
    decorations.push({
      range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      options: {
        className: `collaboration-selection collaboration-color-${colorIndex}`,
        hoverMessage: { value: escapeMarkdown(participantName) },
      },
    });
  }
  decorations.push({
    range: new monaco.Range(head.lineNumber, head.column, head.lineNumber, head.column),
    options: {
      beforeContentClassName: `collaboration-cursor collaboration-color-${colorIndex}`,
      hoverMessage: { value: escapeMarkdown(participantName) },
    },
  });
  return decorations;
}

/**
 * A participant's collaboration cursor, drawn by CodeEditor rather than by
 * y-monaco: its selection decorations, and the name label for its caret.
 */
export function participantCursorDecorations(
  model: PositionedModel,
  participantKey: string,
  participant: CollaborationPresenceState,
  { anchorOffset, headOffset }: { anchorOffset: number; headOffset: number },
): { decorations: monaco.editor.IModelDeltaDecoration[]; label: CollaborationCursorLabel } {
  const selection = resolveRemoteSelection(model, anchorOffset, headOffset);
  const colorIndex = collaboratorColorIndex(participant);
  const participantName = collaboratorDisplayName(participant);
  return {
    decorations: remoteSelectionDecorations(selection, colorIndex, participantName),
    label: { id: participantKey, name: participantName, colorIndex, position: selection.head },
  };
}

/**
 * The CSS for a selection y-monaco draws itself. y-monaco marks it with
 * `yRemoteSelection-<clientId>` classes and leaves their colours to the app.
 */
export function yMonacoSelectionStyleRules(clientId: number, colorIndex: number): string[] {
  const color = collaboratorColor(colorIndex);
  const selectionColor = collaboratorSelectionColor(colorIndex);
  return [
    `.monaco-editor .yRemoteSelection-${clientId}{background:${selectionColor};border-radius:2px}`,
    `.monaco-editor .yRemoteSelectionHead-${clientId}{display:inline-block;height:1.2em;margin-left:-1px;border-left:2px solid ${color};vertical-align:text-bottom}`,
  ];
}

/** A remote selection as the EditorSelection a recording stores. */
export function remoteSelectionToEditorSelection({
  anchor,
  head,
  start,
  end,
}: RemoteSelection): EditorSelection {
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
    selectionStartLineNumber: anchor.lineNumber,
    selectionStartColumn: anchor.column,
    positionLineNumber: head.lineNumber,
    positionColumn: head.column,
  };
}
