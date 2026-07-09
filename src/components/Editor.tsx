import { lazy, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import type { Recording } from "../core/src";
import {
  useNextEditorActions,
  useNextEditorMetadata,
  useNextEditorPlayback,
} from "../hooks/useNextEditorContext";
import { selectLiveTime } from "../core/src/useNextEditor";
import { usePostRecordingTarget } from "../hooks/usePostRecordingTarget";
import { usePlaybackSettings } from "../hooks/usePlaybackSettings";
import { getAudioContext, unlockAudioContext } from "../core/src/utils/audioContext";
import MediaControls from "./MediaControls";
import DragDropOverlay from "./DragDropOverlay";
import SlidePanel from "./SlidePanel";
import FloatingPlayButton from "./FloatingPlayButton";
import { NextEditorProvider } from "../contexts/NextEditorProvider.tsx";
import { PreviewAdapterHandleProvider } from "../contexts/PreviewAdapterHandleContext";
import { SlidesStoreProvider } from "../contexts/SlidesStoreContext";
import { RuntimePanelStoreProvider } from "../contexts/RuntimePanelStoreContext";
import { SlidesProvider } from "../contexts/SlidesContext";
import { WebContainerRuntimeProvider } from "../contexts/WebContainerRuntimeProvider";
import { WorkspaceProvider } from "../contexts/WorkspaceProvider";
import { PreviewPanelProvider } from "../contexts/PreviewPanelContext";
import { useDragAndDropUrl } from "../hooks/useDragAndDropUrl";
import { useUrlQuery } from "../hooks/useUrlQuery";
import CameraOverlay from "./CameraOverlay";
import CaptionsOverlay from "./CaptionsOverlay";
import CursorComponent from "./Cursor.tsx";
import LoadingSpinner from "./LoadingSpinner.tsx";
import RecordingLoadError from "./RecordingLoadError.tsx";
import { ApiClientStoreProvider } from "../contexts/ApiClientStoreContext";
import { CaptionStoreProvider } from "../contexts/CaptionStoreContext";
import { startTour } from "./tour/productTour";

const CodeEditor = lazy(() => import("./CodeEditor"));

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
}

export function EditorLayout({
  readOnly: readOnlyProp,
  recordingUrl,
  largeControls: largeControlsProp,
  fill = false,
  renderPostRecordingModal,
  breadcrumb,
  onEnded,
  playlistMode = false,
  autoplayOverride = false,
}: EditorProps = {}) {
  const { isLoading: urlLoading, error: urlError, retry } = useUrlQuery(recordingUrl);
  const { isDragging, error: dropError, clearError: clearDropError } = useDragAndDropUrl();

  const { isRecording, isPlaying, currentRecording, hasEnded } = useNextEditorMetadata();
  const { play } = useNextEditorActions();
  const { editorActor } = useNextEditorPlayback();
  const { autoplay } = usePlaybackSettings();
  const { target: postRecordingTarget, clear: clearPostRecordingTarget } = usePostRecordingTarget(
    isRecording,
    currentRecording,
  );

  // Props win; otherwise fall back to URL params so the /code route keeps working.
  // Read params through the router (not `window.location.search`) so we share one
  // source of truth with the rest of the app and react to in-app param changes.
  const [searchParams] = useSearchParams();
  const readOnly = readOnlyProp ?? searchParams.get("readOnly") === "true";
  // Enlarge the playback controls for small embeds (e.g. a scaled-down demo iframe).
  const largeControls = largeControlsProp ?? searchParams.get("largeControls") === "true";

  const tourStartedRef = useRef(false);

  // Fire onEnded once per ended-transition (not on every render while ended stays
  // true), so a seek/replay that leaves and re-enters the ended state re-arms it.
  const wasEndedRef = useRef(false);
  useEffect(() => {
    if (hasEnded && !wasEndedRef.current) {
      onEnded?.();
    }
    wasEndedRef.current = hasEnded;
  }, [hasEnded, onEnded]);

  // Autoplay: start playback once a read-only recording has finished loading, when
  // either the persisted Autoplay setting or a one-shot playlist override requests
  // it. Guarded to fire once per recording load — if the browser blocks the
  // unprompted play() (no user gesture on a cold load), playback stays at time 0
  // and FloatingPlayButton remains the visible fallback.
  const autoplayedForRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!readOnly || urlLoading || urlError || !currentRecording || !editorActor) {
      return;
    }
    if (!(autoplay || autoplayOverride) || isPlaying) {
      return;
    }
    if (autoplayedForRef.current === recordingUrl) {
      return;
    }
    if (selectLiveTime(editorActor.getSnapshot()) !== 0) {
      return;
    }
    autoplayedForRef.current = recordingUrl;

    const ctx = getAudioContext();
    unlockAudioContext(ctx);
    ctx.resume().catch(() => {});
    play();
  }, [
    readOnly,
    urlLoading,
    urlError,
    currentRecording,
    autoplay,
    autoplayOverride,
    isPlaying,
    recordingUrl,
    editorActor,
    play,
  ]);

  useEffect(() => {
    // Don't tour inside read-only embeds (the landing-page demo iframe), and wait
    // until any URL-driven recording load has finished. Skip the tour entirely when
    // the load failed — the editor is showing an error panel, not a touchable surface.
    if (urlLoading || urlError || readOnly || tourStartedRef.current) {
      return;
    }

    // Defer one frame so the lazily-mounted editor chrome (header, runner dock)
    // has painted before we query the `data-tour` targets. The frame is left to
    // fire on its own — cancelling it in cleanup would let StrictMode's dev
    // double-invoke abort the tour entirely (run #1 schedules, cleanup cancels,
    // run #2 short-circuits on the ref), so the tour would never auto-start.
    tourStartedRef.current = true;
    requestAnimationFrame(() => {
      startTour();
    });
  }, [urlLoading, urlError, readOnly]);

  return (
    <div
      className={`${fill ? "h-full" : "h-dvh"} flex flex-col text-white overflow-hidden`}
      data-cursor-replay-target="app"
    >
      <div className="flex-1 relative overflow-hidden" data-cursor-replay-target="editor-surface">
        <CodeEditor showImportExport={!readOnly} breadcrumb={breadcrumb} />
        <CursorComponent />
        <CameraOverlay />
        <CaptionsOverlay />
        <SlidePanel />

        {/* Loading / error overlays live inside the (relative) editor surface so they
            center on the editor region in both viewport and `fill` layouts. */}
        {urlLoading ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3">
            <LoadingSpinner />
            <p className="text-sm text-slate-400">Loading recording…</p>
          </div>
        ) : urlError ? (
          <RecordingLoadError message={urlError} onRetry={retry} />
        ) : dropError ? (
          // A dropped file can't be re-fetched, so offer dismiss rather than retry.
          <RecordingLoadError message={dropError} onDismiss={clearDropError} />
        ) : null}
      </div>

      <MediaControls
        recordMode={!readOnly}
        large={largeControls}
        positioning="relative"
        playlistMode={playlistMode}
      />

      <DragDropOverlay isDragging={isDragging} />

      {!urlLoading && !urlError && !dropError ? <FloatingPlayButton /> : null}

      {postRecordingTarget && renderPostRecordingModal
        ? renderPostRecordingModal({
            recording: postRecordingTarget,
            onClose: clearPostRecordingTarget,
          })
        : null}
    </div>
  );
}

export default function Editor(props: EditorProps = {}) {
  return (
    <WorkspaceProvider>
      <WebContainerRuntimeProvider>
        <SlidesStoreProvider>
          <RuntimePanelStoreProvider>
            <PreviewAdapterHandleProvider>
              <CaptionStoreProvider>
                <ApiClientStoreProvider>
                  <NextEditorProvider>
                    <SlidesProvider>
                      <PreviewPanelProvider>
                        <EditorLayout {...props} />
                      </PreviewPanelProvider>
                    </SlidesProvider>
                  </NextEditorProvider>
                </ApiClientStoreProvider>
              </CaptionStoreProvider>
            </PreviewAdapterHandleProvider>
          </RuntimePanelStoreProvider>
        </SlidesStoreProvider>
      </WebContainerRuntimeProvider>
    </WorkspaceProvider>
  );
}
