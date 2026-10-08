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
import type { TextEditEvent } from "../../../types/textEdit";
import { createContentEditDelta, type CreatedContentEditDelta } from "../utils/contentDelta";
import { pushFrame } from "../utils/frameStreamEncoder";
import { getRecordingTimestamp } from "./recordingSession";
import { isRecordingClockPaused } from "./recordingClock";
import { arePositionsEqual, areSelectionsEqual } from "../utils/editorDiff";
import {
  normalizeEditorPosition,
  normalizeEditorSelection,
  normalizeEditorViewState,
  withPrimaryCursorSelection,
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
 * The identity a captured content string or view state is keyed on. `model.id` is
 * unique to one model instance; a URI is not, since a file removed and re-created
 * during the take comes back as a new model under the same URI, its version id
 * starting over at 1.
 */
const readModelIdentity = (model: monaco.editor.ITextModel | null) => ({
  versionId: model?.getVersionId() ?? -1,
  modelId: model?.id ?? "",
});

interface CreateFrameOptions {
  timestamp: number;
  mouseCursor: MouseCursorPosition;
  getSlideState?: EditorMachineInput["getSlideState"];
  getPreviewState?: EditorMachineInput["getPreviewState"];
  /** The last capture's content string and view state, reused by reference when unchanged. */
  previous?: { content?: CapturedContentRef; viewState?: CapturedViewStateRef };
  /** Another collaborator's selection, recorded without moving the local editor. */
  selectionOverride?: EditorSelection;
}

/**
 * Create a frame from current editor state.
 *
 * `previous` lets a capture that changed nothing reuse the last capture's values by
 * reference: the delta encoder's content diff and its `viewState` deep-compare (see
 * `frameDelta.ts`) then short-circuit on reference equality, instead of comparing a
 * fresh `getValue()` copy or `saveViewState()` object against an identical one.
 *
 * - `previous.content` is reused when its `versionId` and `modelId` match the current
 *   model. Version ids restart at 1 on every new model, so the model instance must
 *   match too: a file switch, or a file re-created under the same URI, can land on the
 *   same version id, and reusing the old string would desync the recorded stream.
 * - `previous.viewState` is reused, skipping `saveViewState()` and its normalize pass,
 *   when the model identity, scroll position, selection and cursor position all match,
 *   as on a pointer-only frame. Selection and position are part of the gate, so a
 *   cursor or selection change still saves a fresh (and correctly differing) one.
 */
export const createFrame = (
  editor: monaco.editor.IStandaloneCodeEditor,
  {
    timestamp,
    mouseCursor,
    getSlideState,
    getPreviewState,
    previous,
    selectionOverride,
  }: CreateFrameOptions,
): { frame: EditorFrame; viewStateRef: CapturedViewStateRef } => {
  const previousContent = previous?.content;
  const previousViewState = previous?.viewState;
  const { versionId, modelId } = readModelIdentity(editor.getModel());
  const content =
    previousContent &&
    previousContent.versionId === versionId &&
    previousContent.modelId === modelId
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
    previousViewState.modelId === modelId &&
    previousViewState.scrollTop === scrollTop &&
    previousViewState.scrollLeft === scrollLeft &&
    arePositionsEqual(previousViewState.position, position) &&
    areSelectionsEqual(previousViewState.selection, selection);

  const normalizedViewState = canReuseViewState
    ? previousViewState.value
    : normalizeEditorViewState(editor.saveViewState(), selection, position);
  // normalizeEditorFrame treats the primary cursor as authoritative, so a collaborative
  // selection replaces it here, without moving the host's editor. A reused view state
  // already matches (the reuse gate compared this same selection and position, and
  // Monaco derives the primary cursor from them alone); copying it would lose the reuse.
  const viewState =
    selectionOverride && !canReuseViewState
      ? withPrimaryCursorSelection(normalizedViewState, selection, position)
      : normalizedViewState;

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
    viewStateRef: {
      value: viewState,
      versionId,
      modelId,
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
        modelId: viewStateRef.modelId,
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
    ({ frame: initialFrame, viewStateRef } = createFrame(editor, {
      timestamp: 0,
      mouseCursor: lastMousePosition,
      getSlideState: context.getSlideState,
      getPreviewState: context.getPreviewState,
    }));
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

/**
 * A capture that stores no frame still keeps its pointer sample: the live pointer goes
 * to `lastMousePosition` for the next capture to store, and the revision moves only
 * when the sample was appended to the cursor track.
 */
const keepPointerOnly = (
  context: EditorMachineContext,
  session: RecordingSession,
  mousePosition: MouseCursorPosition,
  cursorAppended: boolean,
): EditorContextUpdate => {
  session.lastMousePosition = mousePosition;
  return {
    session,
    sessionRevision: cursorAppended ? context.sessionRevision + 1 : context.sessionRevision,
  };
};

/**
 * Whether a pointer move lands within MOUSE_FRAME_INTERVAL_MS of the last full frame
 * without changing the pointer's visibility. It compares against `lastMousePosition`, so
 * call it before the sample is kept.
 */
const isThrottledPointerSample = (
  session: RecordingSession,
  timestamp: number,
  mousePosition: MouseCursorPosition,
): boolean => {
  const lastFrame = session.encoder.lastFullFrame;
  return (
    !!lastFrame &&
    timestamp - lastFrame.timestamp < MOUSE_FRAME_INTERVAL_MS &&
    session.lastMousePosition?.visible === mousePosition?.visible
  );
};

/**
 * The content a capture hands `createFrame`: the previous capture's string, advanced by
 * `textEdit` when that edit took this same model from the previous capture's version to
 * the current one. The edit's delta goes to the encoder, so it need not diff the file.
 */
const resolveCapturedContent = (
  previousContent: CapturedContentRef | undefined,
  textEdit: TextEditEvent | undefined,
  model: monaco.editor.ITextModel | null,
): { capturedContent?: CapturedContentRef; contentEditDelta?: CreatedContentEditDelta } => {
  const { versionId, modelId } = readModelIdentity(model);
  if (
    textEdit &&
    previousContent &&
    previousContent.modelId === modelId &&
    previousContent.versionId === textEdit.beforeVersion &&
    versionId === textEdit.afterVersion
  ) {
    const created = createContentEditDelta(previousContent.value, textEdit);
    if (created) {
      return {
        capturedContent: { value: created.content, versionId, modelId },
        contentEditDelta: created,
      };
    }
  }
  return { capturedContent: previousContent };
};

export const captureFrame = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  const session = context.session;
  if (!session) return {};
  const editor = getCaptureEditor(context);

  const timestamp = getRecordingTimestamp(session);

  // SLIDE_EVENT also runs this action: it re-captures the frame with the last pointer.
  const capture = event.type === "CAPTURE_FRAME" ? event : undefined;
  const isPointerMove = Boolean(capture?.isMouseMovement);
  const mousePosition = capture?.mousePosition ?? session.lastMousePosition;

  // While paused the pointer is followed but not recorded: every sample would land on
  // the pause's single instant. Resuming records where it ended up.
  if (isPointerMove && isRecordingClockPaused(session.clock)) {
    session.lastMousePosition = mousePosition;
    return {};
  }
  const cursorAppended =
    isPointerMove && appendCursorEvent(session.cursorEvents, timestamp, mousePosition);

  // The cursor track has no dependency on Monaco — `mousePosition` arrives from
  // mouseTrackingActor fully resolved and lives in its own track. Bailing on a
  // null editor before this point dropped every cursor sample for as long as the
  // active file was a binary asset (CodeEditor nulls both refs then), so the
  // replayed pointer froze while the presenter talked over an image and then
  // teleported when a code file reopened.
  if (!editor) {
    return keepPointerOnly(context, session, mousePosition, cursorAppended);
  }

  if (isPointerMove && isThrottledPointerSample(session, timestamp, mousePosition)) {
    return keepPointerOnly(context, session, mousePosition, cursorAppended);
  }

  const { capturedContent, contentEditDelta } = resolveCapturedContent(
    getPreviousCapturedContent(session, context.currentFrame),
    capture?.textEdit,
    editor.getModel(),
  );

  const { frame, viewStateRef } = createFrame(editor, {
    timestamp,
    mouseCursor: mousePosition,
    getSlideState: context.getSlideState,
    getPreviewState: context.getPreviewState,
    previous: { content: capturedContent, viewState: session.lastCapturedViewStateRef },
    selectionOverride: capture?.selection,
  });

  // The cursor track above already holds every pointer sample, and replay
  // reads frame pointers only for recordings that have no cursor track. A
  // pointer capture therefore gives the encoder the last stored pointer, so
  // it stores a frame only when the capture also sampled something the frame
  // track owns (scroll, preview). currentFrame and lastMousePosition keep the
  // live pointer, which the next capture that is not a pointer move stores.
  const lastStoredFrame = session.encoder.lastStoredFrame;
  const encoderFrame =
    isPointerMove && lastStoredFrame
      ? { ...frame, state: { ...frame.state, mouseCursor: lastStoredFrame.state.mouseCursor } }
      : frame;
  commitCapturedFrame(session, encoderFrame, viewStateRef, contentEditDelta);
  session.lastMousePosition = mousePosition;

  return {
    session,
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
  const { frame, viewStateRef } = createFrame(editor, {
    timestamp,
    mouseCursor: context.session.lastMousePosition,
    getSlideState: context.getSlideState,
    getPreviewState: context.getPreviewState,
    previous: {
      content: getPreviousCapturedContent(context.session, context.currentFrame),
      viewState: context.session.lastCapturedViewStateRef,
    },
  });

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
