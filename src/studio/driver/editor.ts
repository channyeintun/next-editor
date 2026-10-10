import { monaco, workspacePathFromMonacoModelUri } from "../../monaco";
import { POINTER_SETTLE_MS, easePointerDrag } from "../../core/src/utils/pointerMotion";
import { isWorkspaceTextFile } from "../../types/workspace";
import { StudioActionError, abortableSleep, resolveAnchorOffset, tween, waitUntil } from "../async";
import { chunkPlacements, easeInOutCubic } from "../cadence";
import type { StudioDriver, StudioDriverDeps } from "./index";
import { roundPoint, type StudioPointer } from "./pointer";

/**
 * The editor commands: opening a file, typing into the live Monaco model,
 * drag-selecting a range, and asserting a file's content.
 */

// How long a drag-select holds the button on its first character before the
// sweep starts. A hand starts a drag from rest: the press lands, then the
// pointer accelerates — the recordings rest ~360ms at the anchor, of which the
// replay's settle before the gesture shows the first ~220ms.
const DRAG_PRESS_HOLD_MS = 120;

// The shortest scroll toward off-screen code before a drag-select.
const MIN_SELECT_SCROLL_MS = 150;

export function editorCommands(
  deps: Pick<StudioDriverDeps, "getEditor" | "workspace" | "notifyWorkspaceEvent" | "signal">,
  pointer: StudioPointer,
): Pick<StudioDriver, "openFile" | "typeText" | "selectRange" | "expectFile"> {
  const { signal } = deps;

  const activeModelPath = (): string | null => {
    const model = deps.getEditor()?.getModel();
    return model ? workspacePathFromMonacoModelUri(model.uri) : null;
  };

  const requireEditorForPath = (
    path: string,
  ): { editor: monaco.editor.IStandaloneCodeEditor; model: monaco.editor.ITextModel } => {
    const editor = deps.getEditor();
    const model = editor?.getModel();
    if (!editor || !model) {
      throw new StudioActionError("No live editor is attached");
    }
    const modelPath = workspacePathFromMonacoModelUri(model.uri);
    if (modelPath !== path) {
      throw new StudioActionError(
        `The active editor shows "${modelPath ?? "(none)"}" but the action targets "${path}"`,
      );
    }
    return { editor, model };
  };

  // Whether a range sits outside the comfortable viewport band and, if so, the
  // scrollTop that would center it. `needed: false` when it is already visible,
  // so the caller spends no time scrolling.
  const scrollGapForRange = (
    editor: monaco.editor.IStandaloneCodeEditor,
    range: monaco.Range,
  ): { needed: boolean; target: number } => {
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    const viewH = editor.getLayoutInfo().height;
    const top = editor.getTopForPosition(range.startLineNumber, range.startColumn);
    const bottom = editor.getTopForPosition(range.endLineNumber, range.endColumn) + lineHeight;
    const current = editor.getScrollTop();
    const margin = Math.min(lineHeight * 2, viewH / 4);
    const visible = top >= current + margin && bottom <= current + viewH - margin;
    if (visible) return { needed: false, target: current };
    // Center the range; clamp into the scrollable area.
    const maxTop = Math.max(0, editor.getScrollHeight() - viewH);
    const centered = top - Math.max(margin, (viewH - (bottom - top)) / 2);
    const target = Math.max(0, Math.min(maxTop, centered));
    // Code at the very top or bottom sits inside the margin band but cannot
    // scroll any further — that is no scroll, and the drag keeps its whole time.
    return { needed: Math.abs(target - current) >= 1, target };
  };

  // Scroll to `targetTop` with an eased, synchronously-stepped animation and
  // resolve only once it has settled, so the caller can read final layout
  // coordinates. setScrollTop (not Monaco's async ScrollType.Smooth) keeps the
  // motion captured frame-by-frame and deterministic. Matches the recording,
  // where scrolling only happened to reach off-screen code and moved smoothly,
  // roughly a line per 16–50ms — never an instant jump.
  const smoothScrollTo = async (
    editor: monaco.editor.IStandaloneCodeEditor,
    targetTop: number,
    durationMs: number,
  ): Promise<void> => {
    const fromTop = editor.getScrollTop();
    if (Math.abs(targetTop - fromTop) < 1 || durationMs <= 0) {
      editor.setScrollTop(targetTop, monaco.editor.ScrollType.Immediate);
      return;
    }
    await tween(durationMs, easeInOutCubic, signal, (eased) => {
      editor.setScrollTop(
        Math.round(fromTop + (targetTop - fromTop) * eased),
        monaco.editor.ScrollType.Immediate,
      );
    });
  };

  return {
    async openFile(path, timeoutMs) {
      const file = deps.workspace.getFile(path);
      if (!file) {
        throw new StudioActionError(`Workspace has no file "${path}"`);
      }

      deps.workspace.setActiveFilePath(path);
      deps.notifyWorkspaceEvent();

      await waitUntil(() => activeModelPath() === path, {
        timeoutMs,
        signal,
        description: `the editor to show "${path}"`,
      });
      return { path };
    },

    async typeText({ path, anchor, chunks }) {
      const { editor, model } = requireEditorForPath(path);
      const startContent = model.getValue();
      const startOffset = resolveAnchorOffset(startContent, anchor);
      if (startOffset === null) {
        throw new StudioActionError(
          `Anchor occurrence ${anchor.occurrence} of ${JSON.stringify(anchor.after)} not found in "${path}"`,
        );
      }

      // Hands on the keyboard: the caret is where to look, and the OS hides
      // the pointer while typing.
      pointer.hide();
      editor.focus();
      const startPosition = model.getPositionAt(startOffset);
      editor.setSelection(
        new monaco.Selection(
          startPosition.lineNumber,
          startPosition.column,
          startPosition.lineNumber,
          startPosition.column,
        ),
      );
      editor.revealPositionInCenterIfOutsideViewport(startPosition);

      // Chunks may land out of text order (offsetInText — e.g. the Enter
      // press that opens the line before its body is typed), so each chunk's
      // model offset is derived from what is already inserted before it.
      const { relativeOffsets, expectedText } = chunkPlacements(chunks);
      for (const [index, chunk] of chunks.entries()) {
        await abortableSleep(chunk.delayMs, signal);
        const { editor: liveEditor, model: liveModel } = requireEditorForPath(path);
        const insertOffset = startOffset + relativeOffsets[index];
        const position = liveModel.getPositionAt(insertOffset);
        // executeEdits (not the "type" command) so auto-closing pairs and
        // auto-indent cannot alter the planned text; it still flows through
        // onDidChangeModelContent into the workspace bridge and the recorder's
        // exact-edit capture.
        const applied = liveEditor.executeEdits("studio-performer", [
          {
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column,
            ),
            text: chunk.text,
            forceMoveMarkers: true,
          },
        ]);
        if (!applied) {
          throw new StudioActionError(`Monaco rejected an edit in "${path}"`);
        }
        const caret = liveModel.getPositionAt(insertOffset + chunk.text.length);
        liveEditor.setSelection(
          new monaco.Selection(caret.lineNumber, caret.column, caret.lineNumber, caret.column),
        );
        liveEditor.revealPositionInCenterIfOutsideViewport(caret);
      }

      const expected = expectedText;
      const { model: finalModel } = requireEditorForPath(path);
      const inserted = finalModel.getValue().slice(startOffset, startOffset + expected.length);
      if (inserted !== expected) {
        throw new StudioActionError(
          `Typed content diverged in "${path}": expected ${JSON.stringify(expected.slice(0, 40))}…, found ${JSON.stringify(inserted.slice(0, 40))}…`,
        );
      }

      // The Monaco→workspace bridge applies synchronously on the change event;
      // give it a short bounded window anyway so a broken bridge fails loudly
      // here rather than as a silently divergent workspace snapshot.
      await waitUntil(
        () => {
          const file = deps.workspace.getFile(path);
          return (
            file !== null && isWorkspaceTextFile(file) && file.content === finalModel.getValue()
          );
        },
        {
          timeoutMs: 1000,
          signal,
          description: `the workspace store to sync "${path}"`,
        },
      );

      // Record a workspace snapshot of the freshly typed content. Typing is
      // captured as editor-content frames (which rebuild Monaco on replay), but
      // the workspace store the runner reads is restored only from workspace
      // snapshots. Without this, replay leaves the store at the pre-typing
      // (openFile) snapshot, so a Run after playback executes the initial
      // program while the editor shows the final code. Timed at the type
      // action's boundary, it can't disturb the mid-typing animation.
      deps.notifyWorkspaceEvent();

      return { path, insertedChars: expected.length };
    },

    async selectRange({ path, selection, durationMs }) {
      const { editor, model } = requireEditorForPath(path);
      const content = model.getValue();
      const endOffset = resolveAnchorOffset(content, {
        after: selection.text,
        occurrence: selection.occurrence,
      });
      if (endOffset === null) {
        throw new StudioActionError(
          `Selection occurrence ${selection.occurrence} of ${JSON.stringify(selection.text)} not found in "${path}"`,
        );
      }

      const startOffset = endOffset - selection.text.length;
      const startPosition = model.getPositionAt(startOffset);
      const endPosition = model.getPositionAt(endOffset);
      const range = new monaco.Range(
        startPosition.lineNumber,
        startPosition.column,
        endPosition.lineNumber,
        endPosition.column,
      );

      editor.focus();
      // Start the highlight collapsed at the drag's anchor. The selection then
      // grows only as the pointer moves. The recorder captures the model
      // selection (EditorFrame.state.selection via onDidChangeCursorSelection),
      // so every step replays as highlighted text. We dispatch no pointerdown,
      // so Monaco never starts a competing selection of its own; our
      // setSelection stays the sole authority.
      editor.setSelection(
        new monaco.Selection(
          startPosition.lineNumber,
          startPosition.column,
          startPosition.lineNumber,
          startPosition.column,
        ),
      );

      // Scroll the range into view first when it is off-screen (a no-op, 0ms,
      // when already visible — the common case in a small file). The remainder
      // of the budget is the press and the drag, so the select's total
      // wall-clock still equals `durationMs` (the Performer budgets a select by
      // exactly this when checking for overlap). The driver injects no pointer
      // motion before the drag — the pointer rests while the editor scrolls, as
      // a hand on a wheel does; replay carries a resting pointer over to the
      // first character the way a hand would before pressing.
      const node = editor.getDomNode();
      const nodeRect = node?.getBoundingClientRect() ?? null;

      const gap = scrollGapForRange(editor, range);
      const scrollShareMs = gap.needed ? Math.min(Math.round(durationMs * 0.4), 500) : 0;
      // A visible pointer's approach is drawn by replay, landing
      // POINTER_SETTLE_MS before the press. Rest up to that long after the
      // scroll — out of the scroll's own share, so the drag keeps its time — so
      // it lands on text that has stopped moving, not text still sliding in.
      const settleMs =
        scrollShareMs > 0 && !pointer.isHidden()
          ? Math.min(POINTER_SETTLE_MS, Math.max(0, scrollShareMs - MIN_SELECT_SCROLL_MS))
          : 0;
      const scrollMs = scrollShareMs - settleMs;
      if (scrollMs > 0) {
        await smoothScrollTo(editor, gap.target, scrollMs);
      }
      if (settleMs > 0) {
        await abortableSleep(settleMs, signal);
      }

      // Endpoints come from Monaco's own layout, read *after* any scroll settles
      // so the motion tracks the real characters.
      const startVisible = editor.getScrolledVisiblePosition(startPosition);
      const endVisible = editor.getScrolledVisiblePosition(endPosition);
      let dragged = false;
      if (node && nodeRect && startVisible && endVisible) {
        const from = roundPoint({
          x: nodeRect.left + startVisible.left,
          y: nodeRect.top + startVisible.top + startVisible.height / 2,
        });
        const to = {
          x: nodeRect.left + endVisible.left,
          y: nodeRect.top + endVisible.top + endVisible.height / 2,
        };

        // Press on the first character and hold a beat before sweeping: a drag
        // starts from rest. A pointer that was hidden (typing, a slide)
        // reappears right here rather than travelling in from a stale spot.
        pointer.revealAt(from);
        const sweepBudgetMs = Math.max(1, durationMs - scrollMs - settleMs);
        const pressHoldMs = Math.min(DRAG_PRESS_HOLD_MS, Math.round(sweepBudgetMs * 0.2));
        pointer.dispatch(from.x, from.y, node, 1);
        if (pressHoldMs > 0) {
          await abortableSleep(pressHoldMs, signal);
        }
        const dragMs = Math.max(1, sweepBudgetMs - pressHoldMs);

        // The drag *is* the selection: a button-held pointer sweeps straight
        // from the first character to the last — accelerating off the press,
        // peaking early, then a long careful landing (the recorded hands' drag
        // profile, easePointerDrag) — and the selection
        // extends to whatever character sits under the pointer at each step
        // (`getTargetAtClientPoint`). Selection and mouse are one motion — the
        // single behaviour a hand performs — so both cases come out right for
        // free: on one line the highlight grows character by character; across
        // lines it grows line by line, jumping a whole line as the pointer
        // crosses each line's vertical band. It is never a synthetic
        // per-character crawl down a multi-line block.
        let activePosition: monaco.IPosition = startPosition;
        await tween(dragMs, easePointerDrag, signal, (eased) => {
          const px = Math.round(from.x + (to.x - from.x) * eased);
          const py = Math.round(from.y + (to.y - from.y) * eased);
          pointer.dispatch(px, py, node, 1);
          // The selection end is the character under the pointer. Keep the last
          // good hit if a point momentarily maps to no text (gutter/overscroll);
          // the final re-assert below guarantees the exact range regardless.
          const hit = editor.getTargetAtClientPoint(px, py)?.position;
          if (hit) {
            activePosition = hit;
          }
          editor.setSelection(
            new monaco.Selection(
              startPosition.lineNumber,
              startPosition.column,
              activePosition.lineNumber,
              activePosition.column,
            ),
          );
        });
        // Release at the range end so the recorded button state returns to idle.
        // The selection then simply holds here while the narration continues —
        // the recording shows a drag settling and the highlight resting, not the
        // selection vanishing the instant it is made.
        pointer.dispatch(Math.round(to.x), Math.round(to.y), node, 0);
        dragged = true;
      }

      // Re-assert and verify the final range — a select that drifted off its
      // target would silently teach the wrong lines, so fail closed instead.
      editor.setSelection(range);
      const applied = editor.getSelection();
      if (!applied || !monaco.Range.equalsRange(range, applied)) {
        throw new StudioActionError(
          `Selection did not settle over ${JSON.stringify(selection.text)} in "${path}"`,
        );
      }

      return { path, selectedChars: selection.text.length, dragged };
    },

    async expectFile({ path, contains }) {
      const file = deps.workspace.getFile(path);
      if (!file || !isWorkspaceTextFile(file)) {
        throw new StudioActionError(`Workspace has no text file "${path}"`);
      }
      if (!file.content.includes(contains)) {
        throw new StudioActionError(`File "${path}" does not contain ${JSON.stringify(contains)}`);
      }
      return { path };
    },
  };
}
