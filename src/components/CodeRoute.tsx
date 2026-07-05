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
  const handledRef = useRef(false);

  useEffect(() => {
    if (readOnly) return;
    // Wait for the auth query to resolve so isSignedIn reflects the real
    // post-redirect state, not a stale "not signed in yet" default.
    if (authLoading || handledRef.current) return;
    handledRef.current = true;

    (async () => {
      const intent = await loadResumeIntent();
      if (!intent) return;
      await clearResumeIntent(); // used once, regardless of outcome below

      // Backed out of Google's sign-in screen -> nothing to resume into;
      // drop silently, no error banner (there's nothing to apologize for).
      if (!isSignedIn) return;

      const recording = await new RecordingStorage().loadById(intent.recordingId);
      // Recording gone (cleared storage, different device) -> same silent drop.
      if (recording) {
        setResumedRecording(recording);
        setResumedDraft(intent.draft);
      }
    })();
  }, [readOnly, authLoading, isSignedIn]);

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
    </>
  );
}
