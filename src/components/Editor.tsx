import { lazy, Suspense } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import type { Recording } from "../core/src";
import {
  useNextEditorActions,
  useNextEditorMetadata,
  useNextEditorPlayback,
} from "../hooks/useNextEditorContext";
import { useWhiteboardContext } from "../contexts/WhiteboardContext";
import { usePostRecordingTarget } from "../hooks/usePostRecordingTarget";
import { usePlaybackSettings } from "../hooks/usePlaybackSettings";
import { useDemoEmbedLargeControls } from "../hooks/useDemoEmbedLargeControls";
import { useOnPlaybackEnded } from "../hooks/useOnPlaybackEnded";
import { usePauseSessionReplayWhileRecording } from "../hooks/usePauseSessionReplayWhileRecording";
import { useApplyPersistedPlaybackSettings } from "../hooks/useApplyPersistedPlaybackSettings";
import { useAutoplayOnLoad } from "../hooks/useAutoplayOnLoad";
import MediaControls from "./MediaControls";
import DragDropOverlay from "./DragDropOverlay";
import SlidePanel from "./SlidePanel";
import FloatingPlayButton from "./FloatingPlayButton";
import { NextEditorProvider } from "../contexts/NextEditorProvider.tsx";
import { PreviewAdapterHandleProvider } from "../contexts/PreviewAdapterHandleContext";
import { SlidesStoreProvider } from "../contexts/SlidesStoreContext";
import { WhiteboardStoreProvider } from "../contexts/WhiteboardStoreContext";
import { RuntimePanelStoreProvider } from "../contexts/RuntimePanelStoreContext";
import { SlidesProvider } from "../contexts/SlidesContext";
import { WhiteboardProvider } from "../contexts/WhiteboardContext";
import { WebContainerRuntimeProvider } from "../contexts/WebContainerRuntimeProvider";
import { WorkspaceProvider } from "../contexts/WorkspaceProvider";
import { CollaborationProvider, useOptionalCollaboration } from "../contexts/CollaborationContext";
import { CollaborationVoiceProvider } from "../contexts/CollaborationVoiceContext";
import { PreviewPanelProvider } from "../contexts/PreviewPanelContext";
import { useDragAndDropUrl } from "../hooks/useDragAndDropUrl";
import { useUrlLoader } from "../hooks/useUrlLoader";
import { useUrlQuery } from "../hooks/useUrlQuery";
import { POSTHOG_SENSITIVE_ROOT_CLASS } from "../utils/posthogExceptionFilter";
import CameraOverlay from "./CameraOverlay";
import CaptionsOverlay from "./CaptionsOverlay";
import CursorComponent from "./Cursor.tsx";
import LoadingSpinner from "./LoadingSpinner.tsx";
import EditorShellSkeleton, { EditorPlayerBarSkeleton } from "./EditorShellSkeleton.tsx";
import RecordingLoadError from "./RecordingLoadError.tsx";
import RecordingDraftRecovery from "./RecordingDraftRecovery";
import { useLinkedStartTime } from "../hooks/useLinkedStartTime";
import { ApiClientStoreProvider } from "../contexts/ApiClientStoreContext";
import { CaptionStoreProvider } from "../contexts/CaptionStoreContext";
import { useProductTourOnce, type ProductTourOnceOptions } from "./tour/useProductTourOnce";
import CollaborationSurfaceBridge from "./CollaborationSurfaceBridge";
import CollaborationFollowOverlay from "./CollaborationFollowOverlay";
import { loadWhiteboardPanel } from "./whiteboardPanelLoader";

const CodeEditor = lazy(() => import("./CodeEditor"));
// Bundles Excalidraw (~180KB gzip) — deferred until the panel is actually opened,
// not just until this component mounts (see the `isOpen` gate around its render).
const WhiteboardPanel = lazy(loadWhiteboardPanel);

// Rendered inside CodeEditor's Suspense boundary, so it commits only together
// with CodeEditor: most tour targets (header, runner dock, agent tab) live
// there, and with Monaco downloading alongside the route rather than ahead of
// it, CodeEditor can mount well after this shell. Started from the shell, the
// tour would pick its steps from the record bar alone, then mark itself seen.
function ProductTourOnce(options: ProductTourOnceOptions) {
  useProductTourOnce(options);
  return null;
}

export interface EditorProps {
  /** Force read-only playback (hides import/export, record mode, tour). Falls back
   *  to the `?readOnly=true` query param when omitted. */
  readOnly?: boolean;
  /** Recording to load (`.ne` path or URL). Overrides the `?url=` query param. */
  recordingUrl?: string;
  /** Enlarge playback controls for small embeds. Falls back to `?largeControls=true`. */
  largeControls?: boolean;
  /** Fill the parent (`h-full`) instead of the viewport (`h-dvh`), so the editor can
   *  sit below other app chrome. Defaults to viewport. */
  fill?: boolean;
  /** Render an app-supplied UI once a recording finishes (e.g. an upload modal).
   *  Fires exactly once per stop — not for a recording loaded via URL/import, which
   *  never transitions isRecording true->false. Kept generic so this component has
   *  no knowledge of what it renders (infra owns the actual modal). */
  renderPostRecordingModal?: (ctx: { recording: Recording; onClose: () => void }) => ReactNode;
  /** Replaces the editor header's "Editor" label — e.g. the /learn/:slug detail
   *  page's "Lessons > {title}" breadcrumb, so that page doesn't need its own header. */
  breadcrumb?: ReactNode;
  /** Fires once when playback reaches the end of the recording. Used by the /learn
   *  playlist flow to auto-advance to the next lesson; the editor itself has no
   *  notion of a playlist. */
  onEnded?: () => void;
  /** Whether this recording is being played as part of a playlist — passed through
   *  to MediaControls to control the "Continue to Next" setting's visibility. */
  playlistMode?: boolean;
  /** One-shot force-autoplay, independent of the persisted Autoplay setting — set by
   *  the playlist auto-advance flow so the next lesson always starts playing. */
  autoplayOverride?: boolean;
  /** Extra UI mounted inside the full provider stack, as a sibling of the editor
   *  layout — the dev-only studio render console uses this to reach the editor,
   *  workspace, and runtime contexts without duplicating the provider tree. */
  overlay?: ReactNode;
  /** Disable runtime startup caused by workspace load or preview open (Studio owns it). */
  runtimeAutoStart?: boolean;
  /**
   * Keep every take as a recoverable draft while it records, and offer back takes a
   * closed or crashed tab left unsaved. Off for studio renders, which are not the
   * author's to lose. Defaults to on; a read-only editor records nothing either way.
   */
  recordingDrafts?: boolean;
  /**
   * Save the workspace to the one persisted project every tab shares. Off for
   * studio renders, whose performed workspace is not the user's project and
   * would overwrite it on Ctrl-S. Defaults to on.
   */
  persistWorkspace?: boolean;
}

function EditorLayout({
  readOnly: readOnlyProp,
  recordingUrl,
  largeControls: largeControlsProp,
  fill = false,
  renderPostRecordingModal,
  breadcrumb,
  onEnded,
  playlistMode = false,
  autoplayOverride = false,
  recordingDrafts = true,
}: EditorProps = {}) {
  // One loader for the `?url=` lesson and for drops, so whichever load is newest wins and its
  // state is the one shown.
  const recordingLoader = useUrlLoader();
  useUrlQuery(recordingLoader, recordingUrl);
  const { isDragging } = useDragAndDropUrl(recordingLoader);
  const {
    isLoading: recordingLoading,
    error: loadError,
    retry: retryLoad,
    clearError: dismissLoadError,
  } = recordingLoader;

  const { isRecording, isPlaying, currentRecording, hasEnded } = useNextEditorMetadata();
  const { isOpen: isWhiteboardOpen } = useWhiteboardContext();
  const { play, seekTo, setPlaybackSpeed, setVolume, loadRecording } = useNextEditorActions();
  const { editorActor, playbackSpeed, volume } = useNextEditorPlayback();
  const { autoplay, speed: persistedSpeed, volume: persistedVolume } = usePlaybackSettings();
  const {
    target: postRecordingTarget,
    clear: clearPostRecordingTarget,
    offer: offerPostRecordingTarget,
  } = usePostRecordingTarget(isRecording, currentRecording);
  const collaboration = useOptionalCollaboration();

  // Props win; otherwise fall back to URL params so the /code route keeps working.
  // Read params through the router (not `window.location.search`) so we share one
  // source of truth with the rest of the app and react to in-app param changes.
  const [searchParams] = useSearchParams();
  const readOnly = readOnlyProp ?? searchParams.get("readOnly") === "true";

  // Enlarge the playback controls for small embeds (e.g. a scaled-down demo iframe).
  const largeControlsOverride = useDemoEmbedLargeControls();
  const largeControls =
    largeControlsOverride ?? largeControlsProp ?? searchParams.get("largeControls") === "true";

  useOnPlaybackEnded(hasEnded, onEnded);
  usePauseSessionReplayWhileRecording(isRecording);
  useApplyPersistedPlaybackSettings({
    currentRecording,
    playbackSpeed,
    volume,
    persistedSpeed,
    persistedVolume,
    setPlaybackSpeed,
    setVolume,
  });

  // Opens a linked lesson at its moment (?t=). Before autoplay, which then plays from there.
  const getLinkedStart = useLinkedStartTime(currentRecording, searchParams.get("t"), seekTo);
  useAutoplayOnLoad({
    readOnly,
    recordingLoading,
    loadError,
    currentRecording,
    autoplay,
    autoplayOverride,
    isPlaying,
    recordingUrl,
    editorActor,
    play,
    getLinkedStart,
  });

  return (
    <div
      className={`${POSTHOG_SENSITIVE_ROOT_CLASS} ${fill ? "h-full" : "h-dvh"} flex flex-col text-white overflow-hidden`}
      data-cursor-replay-target="app"
    >
      <div className="flex-1 relative overflow-hidden" data-cursor-replay-target="editor-surface">
        {/* CodeEditor statically pulls in Monaco, so its chunk is by far the
            heaviest thing on the critical path. Without a boundary here the
            suspension reaches the root and React can commit nothing at all —
            the caller's loading spinner stays alone on screen until Monaco
            lands, then the entire UI pops in at once. The skeleton lets the
            shell, the player bar, and the "Loading recording…" overlay paint
            immediately instead. */}
        <Suspense fallback={<EditorShellSkeleton breadcrumb={breadcrumb} fill />}>
          <CodeEditor showImportExport={!readOnly} breadcrumb={breadcrumb} />
          <ProductTourOnce
            recordingLoading={recordingLoading}
            loadError={loadError}
            readOnly={readOnly}
          />
        </Suspense>
        <CursorComponent />
        <CameraOverlay />
        <CaptionsOverlay />
        <SlidePanel />
        {isWhiteboardOpen ? (
          <Suspense fallback={null}>
            <WhiteboardPanel />
          </Suspense>
        ) : null}
        <CollaborationFollowOverlay />
        {recordingDrafts && !readOnly && !collaboration?.provider ? (
          <RecordingDraftRecovery
            onRecovered={(recording) => {
              loadRecording(recording);
              offerPostRecordingTarget(recording);
            }}
          />
        ) : null}

        {/* Announces the load to screen readers, including one a Retry or a drop
            starts. Mounted before the load begins rather than with it: a status
            region inserted already filled is often not announced. The overlay
            below is the visual copy and stays hidden from assistive technology. */}
        <p role="status" className="sr-only">
          {recordingLoading ? "Loading recording…" : ""}
        </p>

        {/* Loading / error overlays live inside the (relative) editor surface so they
            center on the editor region in both viewport and `fill` layouts. */}
        {recordingLoading ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3">
            <LoadingSpinner label={null} />
            <p aria-hidden="true" className="text-sm text-slate-400">
              Loading recording…
            </p>
          </div>
        ) : loadError ? (
          // A dropped file can't be re-fetched, so it gets Dismiss rather than Retry.
          <RecordingLoadError
            message={loadError}
            onRetry={retryLoad}
            onDismiss={retryLoad ? undefined : dismissLoadError}
          />
        ) : null}
      </div>

      {/* MediaControls renders nothing until a recording exists, so a surface
          that is fetching one (the /learn detail view) would otherwise grow a
          player bar mid-load and shove the code surface upward. */}
      {recordingUrl && !currentRecording && !loadError ? <EditorPlayerBarSkeleton /> : null}

      <MediaControls
        recordMode={!readOnly}
        large={largeControls}
        positioning="relative"
        playlistMode={playlistMode}
        // An edited take is offered for upload like one that just finished.
        onRecordingEdited={offerPostRecordingTarget}
      />

      <DragDropOverlay isDragging={isDragging} />

      {!recordingLoading && !loadError ? <FloatingPlayButton /> : null}

      {postRecordingTarget && !collaboration?.provider && renderPostRecordingModal
        ? renderPostRecordingModal({
            // The loaded take once it changes in place (chapters renamed after the stop).
            recording:
              currentRecording?.id === postRecordingTarget.id
                ? currentRecording
                : postRecordingTarget,
            onClose: clearPostRecordingTarget,
          })
        : null}
    </div>
  );
}

export default function Editor({
  overlay,
  runtimeAutoStart = true,
  recordingDrafts = true,
  persistWorkspace = true,
  ...props
}: EditorProps = {}) {
  return (
    <WorkspaceProvider pendingRecordingUrl={props.recordingUrl} persist={persistWorkspace}>
      <WebContainerRuntimeProvider allowAmbientStart={runtimeAutoStart}>
        <SlidesStoreProvider>
          <WhiteboardStoreProvider>
            <RuntimePanelStoreProvider>
              <PreviewAdapterHandleProvider>
                <CaptionStoreProvider>
                  <ApiClientStoreProvider>
                    <NextEditorProvider recordingDrafts={recordingDrafts}>
                      <CollaborationProvider>
                        <CollaborationVoiceProvider>
                          <SlidesProvider>
                            <WhiteboardProvider>
                              <PreviewPanelProvider>
                                <CollaborationSurfaceBridge />
                                <EditorLayout {...props} recordingDrafts={recordingDrafts} />
                                {overlay}
                              </PreviewPanelProvider>
                            </WhiteboardProvider>
                          </SlidesProvider>
                        </CollaborationVoiceProvider>
                      </CollaborationProvider>
                    </NextEditorProvider>
                  </ApiClientStoreProvider>
                </CaptionStoreProvider>
              </PreviewAdapterHandleProvider>
            </RuntimePanelStoreProvider>
          </WhiteboardStoreProvider>
        </SlidesStoreProvider>
      </WebContainerRuntimeProvider>
    </WorkspaceProvider>
  );
}
