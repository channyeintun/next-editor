import { useEffect, useId, useRef, useState } from "react";
import { useSelector } from "@xstate/store-react";
import { History, X } from "lucide-react";
import { useDismissOnOutsideInteraction } from "../hooks/useDismissOnOutsideInteraction";
import { useNextEditorActions } from "../hooks/useNextEditorContext";
import {
  forgetLearnerVersion,
  getLearnerVersionsStore,
  openLearnerVersions,
} from "../stores/learnerVersionsStore";
import type { LearnerWorkspaceVersion } from "../storage/learnerWorkspaceVersions";
import { formatPlaybackTime } from "../utils/formatPlaybackTime";

const NO_VERSIONS: LearnerWorkspaceVersion[] = [];

/** How long the "Edits saved" note stays next to the button after a save. */
const SAVED_NOTICE_MS = 4_000;

const formatSavedAgo = (savedAt: number, now: number): string => {
  const minutes = Math.floor((now - savedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(savedAt).toLocaleDateString();
};

interface LearnerVersionsMenuProps {
  recordingId: string;
  iconSize: number;
  buttonClassName: string;
}

/**
 * The viewer's saved edits for the open lesson. Pressing Play (or scrubbing, or
 * leaving) after changing the code hands the workspace back to the recording; the
 * machine saves the viewer's version first, and this menu brings it back — paused,
 * at the point in the lesson where it was made.
 */
export default function LearnerVersionsMenu({
  recordingId,
  iconSize,
  buttonClassName,
}: LearnerVersionsMenuProps) {
  const { restoreLearnerWorkspace } = useNextEditorActions();
  const store = getLearnerVersionsStore();
  const versions = useSelector(store, (snapshot) =>
    snapshot.context.recordingId === recordingId ? snapshot.context.versions : NO_VERSIONS,
  );
  const lastSavedAt = useSelector(store, (snapshot) =>
    snapshot.context.recordingId === recordingId ? snapshot.context.lastSavedAt : null,
  );
  const [isOpen, setIsOpen] = useState(false);
  const [showSavedNotice, setShowSavedNotice] = useState(false);
  /** The version whose Delete is waiting for "Delete" or "Keep". */
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** The version whose Delete button takes focus back after "Keep". */
  const refocusDeleteOfRef = useRef<string | null>(null);
  const popupId = useId();
  const confirmQuestionId = `${popupId}-confirm`;

  useEffect(() => {
    void openLearnerVersions(recordingId);
  }, [recordingId]);

  useEffect(() => {
    if (lastSavedAt === null) return;
    setShowSavedNotice(true);
    const timeout = window.setTimeout(() => setShowSavedNotice(false), SAVED_NOTICE_MS);
    return () => window.clearTimeout(timeout);
  }, [lastSavedAt]);

  const closePopup = () => {
    setIsOpen(false);
    setConfirmingDeleteId(null);
  };

  useDismissOnOutsideInteraction({
    isOpen,
    containerRef,
    onDismiss: () => {
      // Escape from inside the popup unmounts the focused control: hand focus back to the
      // button that opened it rather than dropping it on <body>.
      if (popupRef.current?.contains(document.activeElement)) {
        triggerRef.current?.focus();
      }
      closePopup();
    },
    dismissOnEscape: true,
    listenOn: "document",
  });

  const hasVersions = versions.length > 0;

  const restore = (version: LearnerWorkspaceVersion) => {
    restoreLearnerWorkspace(version.recordingTime, version.snapshot);
    closePopup();
    triggerRef.current?.focus();
  };

  const confirmDelete = (version: LearnerWorkspaceVersion) => {
    setConfirmingDeleteId(null);
    // The last one takes the button with it; do not leave the list open for the next save.
    if (versions.length === 1) setIsOpen(false);
    void forgetLearnerVersion(version.id);
    triggerRef.current?.focus();
  };

  const keepVersion = (version: LearnerWorkspaceVersion) => {
    refocusDeleteOfRef.current = version.id;
    setConfirmingDeleteId(null);
  };

  const now = Date.now();

  // The polite live region is the same node from before the first save onwards: one
  // created in the same commit as its first message is not reliably announced. With no
  // saved edits the wrapper takes no space (`contents`) and the note is screen-reader only.
  return (
    <div
      ref={containerRef}
      className={hasVersions ? "relative flex items-center pointer-events-auto" : "contents"}
    >
      <span
        aria-live="polite"
        className={
          hasVersions
            ? "sr-only text-xs text-slate-400 sm:not-sr-only sm:mr-1 sm:whitespace-nowrap"
            : "sr-only"
        }
      >
        {showSavedNotice ? "Your edits were saved" : ""}
      </span>
      {hasVersions && (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            setConfirmingDeleteId(null);
            setIsOpen((current) => !current);
          }}
          aria-label={`Your edits, ${versions.length} saved`}
          aria-expanded={isOpen}
          aria-controls={popupId}
          title="Your edits"
          className={`relative flex items-center justify-center text-slate-300 transition-colors hover:text-white ${buttonClassName}`}
        >
          <History size={iconSize} aria-hidden="true" />
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 min-w-3.5 rounded-full bg-blue-400 px-0.5 text-center text-[10px] leading-3.5 font-semibold text-slate-950"
          >
            {versions.length}
          </span>
        </button>
      )}

      {hasVersions && isOpen && (
        <div
          ref={popupRef}
          id={popupId}
          role="group"
          aria-label="Your edits"
          className="absolute bottom-full right-0 z-46 mb-2 w-64 rounded-lg border border-slate-700 bg-[#151821] py-1 shadow-[0_18px_40px_rgba(2,6,23,0.45)]"
        >
          <p className="px-3 pt-1.5 pb-1 text-xs text-slate-400">
            Your edits are saved when the lesson continues. Restore one to pick up where you left
            off.
          </p>
          {versions.map((version) => (
            <div
              key={version.id}
              className={
                confirmingDeleteId === version.id
                  ? "flex min-h-12 items-center"
                  : "flex items-center hover:bg-slate-700"
              }
            >
              {confirmingDeleteId === version.id ? (
                // A saved version is the learner's own work: deleting it is checked first.
                <>
                  <span id={confirmQuestionId} className="mr-auto px-3 text-xs text-slate-300">
                    Delete these edits?
                  </span>
                  <button
                    type="button"
                    onClick={() => confirmDelete(version)}
                    aria-describedby={confirmQuestionId}
                    className="mr-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    autoFocus
                    onClick={() => keepVersion(version)}
                    aria-describedby={confirmQuestionId}
                    className="mr-2 rounded-md px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-700 hover:text-white"
                  >
                    Keep
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => restore(version)}
                    className="flex min-w-0 flex-1 flex-col items-start px-3 py-1.5 text-left"
                  >
                    <span className="text-sm text-white">
                      Restore edits at {formatPlaybackTime(version.recordingTime)}
                    </span>
                    <span className="text-xs text-slate-400">
                      Saved {formatSavedAgo(version.savedAt, now)}
                    </span>
                  </button>
                  <button
                    ref={(node) => {
                      if (node && refocusDeleteOfRef.current === version.id) {
                        refocusDeleteOfRef.current = null;
                        node.focus();
                      }
                    }}
                    type="button"
                    onClick={() => setConfirmingDeleteId(version.id)}
                    aria-label={`Delete edits saved at ${formatPlaybackTime(version.recordingTime)}`}
                    title="Delete"
                    className="mr-2 flex shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-600 hover:text-white size-6"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
