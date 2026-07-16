import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import Editor from "./Editor";
import { RecordingStorage } from "../storage/RecordingStorage";
import type { Recording } from "../core/src";
import {
  UploadLessonModal,
  useAuth,
  loadResumeIntent,
  clearResumeIntent,
  type ResumeIntent,
} from "@next-editor/infra";

// Composition root for /code: this is the one place that wires infra's
// upload modal into the editor (renderPostRecordingModal), plus a second,
// independent trigger for the "resume after the OAuth redirect" case — a
// full-page navigation remounts the whole app, so Editor's live
// isRecording-edge trigger can't fire again on return. See
// docs/upload-modal-ux-spec.md's "signed-out flow".
export default function CodeRoute() {
  // Same readOnly derivation as Editor.tsx. Gates the resume-check below:
  // the landing page's embedded live-demo iframe also loads /code
  // (?readOnly=true) — that path can never trigger an upload (recording is
  // disabled), so it shouldn't pay for an extra /api/auth/me fetch + an
  // IndexedDB open on every mount. That iframe has a history of being a
  // fragile, crash-prone surface on mobile (see isMobileBrowser() in
  // LandingPage) — no reason to add work to it it'll never use.
  const [searchParams] = useSearchParams();
  const readOnly = searchParams.get("readOnly") === "true";

  const { isSignedIn, isLoading: authLoading } = useAuth({ enabled: !readOnly });
  const [resumedRecording, setResumedRecording] = useState<Recording | null>(null);
  const [resumedDraft, setResumedDraft] = useState<ResumeIntent["draft"]>(undefined);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resumeAttempt, setResumeAttempt] = useState(0);
  const resumeCompletedRef = useRef(false);

  useEffect(() => {
    if (readOnly) return;
    // Wait for the auth query to resolve so isSignedIn reflects the real
    // post-redirect state, not a stale "not signed in yet" default.
    if (authLoading || resumeCompletedRef.current) return;
    let cancelled = false;

    void (async () => {
      try {
        const intent = await loadResumeIntent();
        if (cancelled) return;
        if (!intent) {
          resumeCompletedRef.current = true;
          return;
        }

        // Backed out of Google's sign-in screen -> nothing to resume into;
        // this is a confirmed terminal outcome, so consume the intent.
        if (!isSignedIn) {
          await clearResumeIntent();
          resumeCompletedRef.current = true;
          return;
        }

        const recording = await new RecordingStorage().loadById(intent.recordingId);
        if (cancelled) return;

        // The recording was deliberately removed or belongs to another device.
        if (!recording) {
          await clearResumeIntent();
          resumeCompletedRef.current = true;
          return;
        }

        setResumedRecording(recording);
        setResumedDraft(intent.draft);
        setResumeError(null);
        resumeCompletedRef.current = true;

        // The modal now owns a complete in-memory recording, so consuming the
        // retry pointer cannot lose the pending upload.
        try {
          await clearResumeIntent();
        } catch (error) {
          console.warn("Failed to clear the upload resume intent:", error);
        }
      } catch (error) {
        if (!cancelled) {
          setResumeError(
            error instanceof Error ? error.message : "The pending upload could not be restored.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [readOnly, authLoading, isSignedIn, resumeAttempt]);

  return (
    <>
      <Editor
        renderPostRecordingModal={(ctx) => (
          <UploadLessonModal recording={ctx.recording} onClose={ctx.onClose} />
        )}
      />
      {resumedRecording ? (
        <UploadLessonModal
          recording={resumedRecording}
          onClose={() => setResumedRecording(null)}
          initialTitle={resumedDraft?.title}
          initialDescription={resumedDraft?.description}
          initialTags={resumedDraft?.tags}
        />
      ) : null}
      {resumeError ? (
        <div
          role="alert"
          className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-rose-500/30 bg-[#1b151a] p-3 text-xs text-rose-100 shadow-xl"
        >
          <p>Pending upload recovery failed: {resumeError}</p>
          <button
            type="button"
            className="mt-2 rounded bg-rose-500/20 px-2.5 py-1 font-semibold text-rose-200 hover:bg-rose-500/30"
            onClick={() => {
              resumeCompletedRef.current = false;
              setResumeError(null);
              setResumeAttempt((attempt) => attempt + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
    </>
  );
}
