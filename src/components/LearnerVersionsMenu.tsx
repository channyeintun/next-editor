import { useEffect, useRef, useState } from "react";
import { useSelector } from "@xstate/store-react";
import { History, X } from "lucide-react";
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
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void openLearnerVersions(recordingId);
  }, [recordingId]);

  useEffect(() => {
    if (lastSavedAt === null) return;
    setShowSavedNotice(true);
    const timeout = window.setTimeout(() => setShowSavedNotice(false), SAVED_NOTICE_MS);
    return () => window.clearTimeout(timeout);
  }, [lastSavedAt]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  if (versions.length === 0) return null;

  const restore = (version: LearnerWorkspaceVersion) => {
    restoreLearnerWorkspace(version.recordingTime, version.snapshot);
    setIsOpen(false);
  };

  const now = Date.now();

  return (
    <div ref={containerRef} className="relative flex items-center pointer-events-auto">
      <span
        aria-live="polite"
        className="mr-1 hidden text-xs whitespace-nowrap text-slate-400 sm:inline"
      >
        {showSavedNotice ? "Your edits were saved" : ""}
      </span>
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title="Your edits"
        className={`relative flex items-center justify-center text-slate-300 transition-colors hover:text-white ${buttonClassName}`}
      >
        <History size={iconSize} aria-hidden="true" />
        <span className="absolute -top-1 -right-1 min-w-3.5 rounded-full bg-blue-500 px-0.5 text-center text-[10px] leading-3.5 font-semibold text-white">
          {versions.length}
        </span>
      </button>

      {isOpen && (
        <div
          role="menu"
          aria-label="Your edits"
          className="absolute bottom-full right-0 z-46 mb-2 w-64 rounded-lg border border-slate-700 bg-[#151821] py-1 shadow-[0_18px_40px_rgba(2,6,23,0.45)]"
        >
          <p className="px-3 pt-1.5 pb-1 text-xs text-slate-400">
            Your edits are saved when the lesson continues. Restore one to pick up where you left
            off.
          </p>
          {versions.map((version) => (
            <div key={version.id} className="flex items-center hover:bg-slate-700">
              <button
                type="button"
                role="menuitem"
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
                type="button"
                onClick={() => void forgetLearnerVersion(version.id)}
                aria-label={`Delete edits saved at ${formatPlaybackTime(version.recordingTime)}`}
                title="Delete"
                className="mr-2 flex shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-600 hover:text-white size-6"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
