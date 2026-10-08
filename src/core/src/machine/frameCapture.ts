import type * as monaco from "monaco-editor";
import type {
  CapturedContentRef,
  CapturedViewStateRef,
  EditorActionArgs,
  EditorContextUpdate,
  EditorMachineContext,
  EditorMachineInput,
  RecordingSession,
} from "./types";
import type {
  CursorRecordingEvent,
  EditorFrame,
  EditorSelection,
  MouseCursorPosition,
} from "../types";
import { createContentEditDelta, type CreatedContentEditDelta } from "../utils/frameDelta";
import { pushFrame } from "../utils/frameStreamEncoder";
import { getRecordingTimestamp } from "./recordingSession";
import { isRecordingClockPaused } from "./recordingClock";
import { arePositionsEqual, areSelectionsEqual } from "../utils/editorDiff";
import {
  normalizeEditorPosition,
  normalizeEditorSelection,
  normalizeEditorViewState,
} from "../utils/editorState";
import { areMouseCursorPositionsEqual } from "../utils/cursorCoordinates";

// ============================================================================
// Editor frame and cursor capture
//
// The capture-side action bodies that sample the live Monaco editor into the
// take's frame stream (captureInitialFrame, captureFrame,
// capturePreviewRefreshFrame) and the pointer into its cursor track, with the
// caching that lets a capture reuse the previous content string and view
// state by reference. editorMachine.ts wires them into `setup()` like the
// other capture bodies in captureActions.ts.
// ============================================================================

// Capture reads the live editor: fall back to the input ref getter so a
// SET_EDITOR_REF event lost to a stopped-actor window (StrictMode/Suspense
// rehydration) cannot silently disable frame/cursor capture.
const getCaptureEditor = (context: EditorMachineContext) =>
  context.editorRefs.editor ?? context.getEditorInstance();

/**
 * A pointer move this soon after the last full frame records only its cursor sample, not
 * a frame of its own (unless the pointer's visibility changed).
 */
const MOUSE_FRAME_INTERVAL_MS = 50;

/**
 * Create a frame from current editor state.
 *
 * `previousContent`, when both its `versionId` and `modelUri` match the current
 * model, lets the frame reuse the prior content string by reference instead of
 * calling `editor.getValue()` again. This matters for mouse/selection frames (no
 * document edit since the last capture): the caller's content-delta diff already
 * short-circuits on `prev === next` by reference, so avoiding a fresh `getValue()`
 * copy turns that into an O(1) check instead of an O(doc) string equality scan
 * preceded by an O(doc) copy.
 *
 * The `modelUri` check matters because this is a multi-file workspace — Monaco's
 * `getVersionId()` is a per-model counter, so switching the active file between
 * captures can coincidentally produce the same numeric version id on the new
 * model. Without also checking the model URI, that coincidence would silently
 * reuse the previous file's content string for the new file, desyncing the
 * recorded stream.
 *
 * `previousViewState` similarly lets the frame reuse the prior `viewState`
 * object by reference, skipping `editor.saveViewState()` and the normalize pass
 * over it, whenever the values that `saveViewState()` would derive from —
 * content version, model, scroll position, selection, and cursor position — are
 * all unchanged since the last capture. This is the case for mouse-move-only
 * frames (`onDidScrollChange`/pointer frames with no edit, no scroll, no
 * selection change): `saveViewState()` would return a structurally identical
 * (but freshly allocated) object, and the delta encoder's `areStructuredDataEqual`
 * deep-compare on `viewState` (see `frameDelta.ts`) already short-circuits on
 * reference equality, so reusing the reference turns that deep compare into an
 * O(1) check. Selection/position changes still invalidate the reuse — they are
 * part of the gate, not bypassed by it — so cursor/selection-only frames still
 * get a freshly saved (and correctly differing) viewState.
 */
export const createFrame = (
  editor: monaco.editor.IStandaloneCodeEditor,
  timestamp: number,
  mouseCursor: MouseCursorPosition,
  getSlideState?: EditorMachineInput["getSlideState"],
  getPreviewState?: EditorMachineInput["getPreviewState"],
  previousContent?: CapturedContentRef,
  previousViewState?: CapturedViewStateRef,
  selectionOverride?: EditorSelection,
): {
  frame: EditorFrame;
  contentVersionId: number;
  modelUri: string;
  viewStateRef: CapturedViewStateRef;
} => {
  const model = editor.getModel();
  const versionId = model?.getVersionId() ?? -1;
  const modelUri = model?.uri.toString() ?? "";
  const content =
    previousContent &&
    previousContent.versionId === versionId &&
    previousContent.modelUri === modelUri
      ? previousContent.value
      : editor.getValue();
  const editorPosition = normalizeEditorPosition(editor.getPosition());
  const selection = normalizeEditorSelection(
    selectionOverride ?? editor.getSelection(),
    undefined,
    editorPosition,
  );
  const position = selectionOverride
    ? normalizeEditorPosition({
        lineNumber: selection.positionLineNumber,
        column: selection.positionColumn,
      })
    : editorPosition;
  const scrollTop = editor.getScrollTop();
  const scrollLeft = editor.getScrollLeft();

  const canReuseViewState =
    previousViewState !== undefined &&
    previousViewState.versionId === versionId &&
    previousViewState.modelUri === modelUri &&
    previousViewState.scrollTop === scrollTop &&
    previousViewState.scrollLeft === scrollLeft &&
    arePositionsEqual(previousViewState.position, position) &&
    areSelectionsEqual(previousViewState.selection, selection);

  const viewState = canReuseViewState
    ? previousViewState.value
    : normalizeEditorViewState(editor.saveViewState(), selection, position);

  // normalizeEditorFrame treats Monaco's primary cursorState as authoritative.
  // Replace that primary cursor in a freshly normalized (cloned) view state so a
  // collaborative selection survives frame normalization without moving the
  // host's editor. A reused view state already matches: the reuse gate compared
  // the same selection and position, and Monaco derives cursorState[0] from the
  // primary selection alone. It is also the previous frame's object, so writing
  // into it would change a frame that is already recorded.
  if (selectionOverride && viewState && !canReuseViewState) {
    const mutableViewState = viewState as unknown as {
      cursorState?: Array<Record<string, unknown>>;
    };
    const cursorState = mutableViewState.cursorState;
    const primaryCursorState = cursorState?.[0];
    if (primaryCursorState) {
      cursorState[0] = {
        ...primaryCursorState,
        inSelectionMode:
          selection.selectionStartLineNumber !== selection.positionLineNumber ||
          selection.selectionStartColumn !== selection.positionColumn,
        selectionStart: {
          lineNumber: selection.selectionStartLineNumber,
          column: selection.selectionStartColumn,
        },
        position,
        selection,
      };
    }
  }

  const slideState = getSlideState?.();
  const previewState = getPreviewState?.();

  return {
    frame: {
      timestamp,
      state: {
        content,
        selection,
        position,
        viewState,
        mouseCursor,
        slideState: slideState?.previewState,
        currentSlideIndex: slideState?.currentSlideIndex,
        previewState: previewState || undefined,
      },
    },
    contentVersionId: versionId,
    modelUri,
    viewStateRef: {
      value: viewState,
      versionId,
      modelUri,
      scrollTop,
      scrollLeft,
      selection,
      position,
    },
  };
};

const didCursorPositionChange = (
  previous: MouseCursorPosition | undefined,
  next: MouseCursorPosition | undefined,
): boolean => {
  return !areMouseCursorPositionsEqual(previous, next);
};

/**
 * Pushes in place, so `cursorEvents` keeps its identity until a retake replaces it (see
 * the mutable capture buffer invariant on {@link RecordingSession}). Returns `false` when
 * the position deduplicates against the last event (no push happened) so callers know
 * whether to bump `sessionRevision`.
 */
export const appendCursorEvent = (
  cursorEvents: CursorRecordingEvent[],
  timestamp: number,
  mousePosition: MouseCursorPosition | undefined,
): boolean => {
  if (!mousePosition) return false;

  const lastCursorEvent = cursorEvents[cursorEvents.length - 1];
  const cursorChanged = didCursorPositionChange(lastCursorEvent, mousePosition);

  if (!cursorChanged) {
    return false;
  }

  cursorEvents.push({ timestamp, ...mousePosition });
  return true;
};

/**
 * The last captured content string paired with the model identity it was read at, for
 * `createFrame` to reuse by reference. `lastCapturedViewStateRef` holds that identity: it
 * comes from the same `createFrame` call that produced `currentFrame`.
 */
const getPreviousCapturedContent = (
  session: RecordingSession,
  currentFrame: EditorFrame | null,
): CapturedContentRef | undefined => {
  const viewStateRef = session.lastCapturedViewStateRef;
  return currentFrame && viewStateRef
    ? {
        value: currentFrame.state.content,
        versionId: viewStateRef.versionId,
        modelUri: viewStateRef.modelUri,
      }
    : undefined;
};

/**
 * A frame's previewState.content is the preview page's whole HTML: the replay
 * fallback for a take whose live preview has no rrweb seed. Once the take holds one
 * (an initial document with events), replay rebuilds the preview from that stream
 * and never reads the fallback (usePreviewPlaybackRegistration), so storing it would
 * only add a page copy per frame segment and a diff per edit to the file. A retake
 * that discards the seed also discards every frame captured after it.
 */
const withoutUnreplayedPreviewContent = (
  session: RecordingSession,
  frame: EditorFrame,
): EditorFrame => {
  const previewState = frame.state.previewState;
  if (
    previewState?.content === undefined ||
    !session.previewInitialDocuments.some((document) => document.events?.length)
  ) {
    return frame;
  }

  const { content: _content, ...rest } = previewState;
  return { ...frame, state: { ...frame.state, previewState: rest } };
};

/** Encode a captured frame into the session (in place) and keep its view state for reuse. */
const commitCapturedFrame = (
  session: RecordingSession,
  frame: EditorFrame,
  viewStateRef: CapturedViewStateRef | undefined,
  contentEditDelta?: CreatedContentEditDelta,
): void => {
  const { state: encoder, emitted } = pushFrame(
    session.encoder,
    withoutUnreplayedPreviewContent(session, frame),
    contentEditDelta,
  );
  if (emitted) {
    session.frames.push(emitted);
  }
  session.encoder = encoder;
  session.lastCapturedViewStateRef = viewStateRef;
};

export const captureInitialFrame = ({ context }: EditorActionArgs): EditorContextUpdate => {
  const session = context.session;
  if (!session) return {};

  const lastMousePosition = session.lastMousePosition;

  // Use createFrame for the initial frame to ensure it has all metadata
  const editor = getCaptureEditor(context);
  let initialFrame: EditorFrame;
  let viewStateRef: CapturedViewStateRef | undefined;

  if (editor) {
    ({ frame: initialFrame, viewStateRef } = createFrame(
      editor,
      0,
      lastMousePosition,
      context.getSlideState,
      context.getPreviewState,
    ));
  } else {
    initialFrame = {
      timestamp: 0,
      state: {
        content: "",
        selection: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 1,
          selectionStartLineNumber: 1,
          selectionStartColumn: 1,
          positionLineNumber: 1,
          positionColumn: 1,
        },
        position: { lineNumber: 1, column: 1 },
        viewState: null,
        mouseCursor: lastMousePosition,
      },
    };
  }

  commitCapturedFrame(session, initialFrame, viewStateRef);

  return {
    session,
    sessionRevision: context.sessionRevision + 1,
    currentFrame: initialFrame,
  };
};

export const captureFrame = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  const editor = getCaptureEditor(context);
  if (!context.session) return {};

  const timestamp = getRecordingTimestamp(context.session);

  const mousePosition =
    event.type === "CAPTURE_FRAME" && event.mousePosition
      ? event.mousePosition
      : context.session.lastMousePosition;

  // While paused the pointer is followed but not recorded: every sample would land on
  // the pause's single instant. Resuming records where it ended up.
  if (
    event.type === "CAPTURE_FRAME" &&
    event.isMouseMovement &&
    isRecordingClockPaused(context.session.clock)
  ) {
    context.session.lastMousePosition = mousePosition;
    return {};
  }
  const cursorAppended =
    event.type === "CAPTURE_FRAME" && event.isMouseMovement
      ? appendCursorEvent(context.session.cursorEvents, timestamp, mousePosition)
      : false;

  // The cursor track has no dependency on Monaco — `mousePosition` arrives from
  // mouseTrackingActor fully resolved and lives in its own track. Bailing on a
  // null editor before this point dropped every cursor sample for as long as the
  // active file was a binary asset (CodeEditor nulls both refs then), so the
  // replayed pointer froze while the presenter talked over an image and then
  // teleported when a code file reopened.
  if (!editor) {
    context.session.lastMousePosition = mousePosition;
    return {
      session: context.session,
      sessionRevision: cursorAppended ? context.sessionRevision + 1 : context.sessionRevision,
    };
  }

  if (event.type === "CAPTURE_FRAME" && event.isMouseMovement) {
    const lastFrame = context.session.encoder.lastFullFrame;
    const lastMousePosition = context.session.lastMousePosition;
    const visibilityChanged = lastMousePosition?.visible !== mousePosition?.visible;

    if (
      lastFrame &&
      timestamp - lastFrame.timestamp < MOUSE_FRAME_INTERVAL_MS &&
      !visibilityChanged
    ) {
      context.session.lastMousePosition = mousePosition;
      return {
        session: context.session,
        sessionRevision: cursorAppended ? context.sessionRevision + 1 : context.sessionRevision,
      };
    }
  }

  const previousContent = getPreviousCapturedContent(context.session, context.currentFrame);

  let capturedContent = previousContent;
  let contentEditDelta: CreatedContentEditDelta | undefined;
  const textEdit = event.type === "CAPTURE_FRAME" ? event.textEdit : undefined;
  const model = editor.getModel();
  const currentModelUri = model?.uri.toString() ?? "";
  const currentVersionId = model?.getVersionId() ?? -1;
  if (
    textEdit &&
    previousContent &&
    previousContent.modelUri === currentModelUri &&
    previousContent.versionId === textEdit.beforeVersion &&
    currentVersionId === textEdit.afterVersion
  ) {
    const created = createContentEditDelta(previousContent.value, textEdit);
    if (created) {
      capturedContent = {
        value: created.content,
        versionId: currentVersionId,
        modelUri: currentModelUri,
      };
      contentEditDelta = created;
    }
  }

  const { frame, viewStateRef } = createFrame(
    editor,
    timestamp,
    mousePosition,
    context.getSlideState,
    context.getPreviewState,
    capturedContent,
    context.session.lastCapturedViewStateRef,
    event.type === "CAPTURE_FRAME" ? event.selection : undefined,
  );

  // The cursor track above already holds every pointer sample, and replay
  // reads frame pointers only for recordings that have no cursor track. A
  // pointer capture therefore gives the encoder the last stored pointer, so
  // it stores a frame only when the capture also sampled something the frame
  // track owns (scroll, preview). currentFrame and lastMousePosition keep the
  // live pointer, which the next capture that is not a pointer move stores.
  const lastStoredFrame = context.session.encoder.lastStoredFrame;
  const encoderFrame =
    event.type === "CAPTURE_FRAME" && event.isMouseMovement && lastStoredFrame
      ? { ...frame, state: { ...frame.state, mouseCursor: lastStoredFrame.state.mouseCursor } }
      : frame;
  commitCapturedFrame(context.session, encoderFrame, viewStateRef, contentEditDelta);
  context.session.lastMousePosition = mousePosition;

  return {
    session: context.session,
    sessionRevision: context.sessionRevision + 1,
    currentFrame: frame,
  };
};

export const capturePreviewRefreshFrame = ({
  context,
  event,
}: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "PREVIEW_EVENT" || event.event.type !== "preview_refresh") {
    return {};
  }

  const editor = getCaptureEditor(context);
  if (!editor || !context.session) {
    return {};
  }

  const timestamp = getRecordingTimestamp(context.session);
  const { frame, viewStateRef } = createFrame(
    editor,
    timestamp,
    context.session.lastMousePosition,
    context.getSlideState,
    context.getPreviewState,
    getPreviousCapturedContent(context.session, context.currentFrame),
    context.session.lastCapturedViewStateRef,
  );

  if (frame.state.previewState) {
    frame.state.previewState = {
      ...frame.state.previewState,
      content: event.event.content ?? frame.state.previewState.content,
    };
  }

  commitCapturedFrame(context.session, frame, viewStateRef);

  return {
    session: context.session,
    sessionRevision: context.sessionRevision + 1,
    currentFrame: frame,
  };
};
