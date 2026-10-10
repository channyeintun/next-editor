import { useEffect, useEffectEvent, useRef, useState } from "react";
import { FileSearch } from "lucide-react";
import { useNextEditorActions, useNextEditorMetadata } from "../../hooks/useNextEditorContext";
import { useIsWorkspaceCovered } from "../../hooks/useIsWorkspaceCovered";
import { useOpenWorkspaceFile } from "../../hooks/useOpenWorkspaceFile";
import type { WorkspaceTreeFile } from "../../types/workspace";
import { isApplePlatform } from "../../utils/keyboardPlatform";
import {
  HEADER_ICON_BUTTON_CLASS,
  HEADER_ICON_BUTTON_NEUTRAL_CLASS,
} from "../editorHeader/headerButtonClasses";
import { isProductTourActive } from "../tour/productTour";
import {
  goToFileAriaKeyShortcuts,
  goToFileShortcutLabel,
  isGoToFileShortcut,
} from "./goToFileShortcut";
import QuickOpenDialog from "./QuickOpenDialog";

/**
 * Go to File's header button, and the Cmd+P / Ctrl+P that opens it from
 * anywhere in the editor. While it is open a lesson stays paused, as when the
 * slides open, so the replay cannot switch files or cover the editor under it.
 */
export default function QuickOpenButton() {
  const [isApple] = useState(isApplePlatform);
  const [isOpen, setIsOpen] = useState(false);
  // Keyed by time, so opening the same file twice is announced twice.
  const [announcement, setAnnouncement] = useState<{ text: string; at: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const isCovered = useIsWorkspaceCovered();
  const isPlaying = useNextEditorMetadata((metadata) => metadata.isPlaying);
  const { pause, editorRef } = useNextEditorActions();
  const openWorkspaceFile = useOpenWorkspaceFile();
  const isShowing = isOpen && !isCovered;

  // A deck or the whiteboard drawn over the workspace closes the picker under it.
  useEffect(() => {
    if (isCovered) setIsOpen(false);
  }, [isCovered]);

  // Whatever starts playback while the picker is up (autoplay finishing a
  // load, a playlist moving on) is paused again.
  useEffect(() => {
    if (isShowing && isPlaying) pause();
  }, [isShowing, isPlaying, pause]);

  const open = () => {
    if (isCovered) return;
    pause();
    const focused = document.activeElement;
    openerRef.current =
      focused instanceof HTMLElement && focused !== document.body ? focused : null;
    // Cancelled, the picker gives focus back to whatever opened it.
    returnFocusRef.current = null;
    setIsOpen(true);
  };

  const dismiss = () => {
    // An opener that closed under the picker (the file explorer's context
    // menu, which the picker's field blurs shut) cannot take focus back.
    if (!openerRef.current?.isConnected) returnFocusRef.current = buttonRef.current;
    setIsOpen(false);
  };

  const choose = (file: WorkspaceTreeFile) => {
    // Focus lands on the editor region as the dialog closes, then moves into
    // Monaco once it shows the new file. Monaco's label names the file, so a
    // screen reader hears the switch. An image, video or audio file has no
    // editor, and a full-height runtime dock hides it; then the switch is
    // announced instead.
    returnFocusRef.current = document.getElementById("editor-main");
    openWorkspaceFile(file.path);
    setIsOpen(false);
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      const node = editor?.getDomNode();
      if (node?.isConnected) editor?.focus();
      if (!node?.contains(document.activeElement)) {
        setAnnouncement({ text: `Opened ${file.name}`, at: Date.now() });
      }
    });
  };

  const onWindowKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!isGoToFileShortcut(event, isApple)) return;
    // Never the browser's Print, whatever happens next.
    event.preventDefault();
    // Pressed again in the picker, the key moves down the results there.
    if (isOpen) return;
    // Not stopImmediatePropagation: the editor's save and undo keys and the
    // tour's first-key mark listen on window too. This keeps it from Monaco,
    // the terminal and the whiteboard.
    event.stopPropagation();
    if (event.repeat || isCovered) return;
    // Another dialog, an open menu or the product tour owns the keyboard.
    if (document.querySelector('[aria-modal="true"]') || isProductTourActive()) return;
    if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
    open();
  });

  useEffect(() => {
    // Capture, so it runs before Monaco, xterm (which turns Ctrl+P into ^P)
    // and the whiteboard handle the key.
    const handleKeyDown = (event: KeyboardEvent) => onWindowKeyDown(event);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  const shortcutLabel = goToFileShortcutLabel(isApple);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Go to file"
        aria-haspopup="dialog"
        aria-expanded={isShowing}
        aria-keyshortcuts={goToFileAriaKeyShortcuts(isApple)}
        title={`Go to file (${shortcutLabel})`}
        onClick={open}
        className={`${HEADER_ICON_BUTTON_CLASS} ${HEADER_ICON_BUTTON_NEUTRAL_CLASS}`}
      >
        <FileSearch size={16} aria-hidden="true" />
      </button>
      {/* Mounted before any message and never re-created, so each one is announced. */}
      <span role="status" className="sr-only">
        {announcement ? <span key={announcement.at}>{announcement.text}</span> : null}
      </span>
      {isShowing ? (
        // A layer of its own above z-50, so the header popovers later in the
        // tree (Live collaboration, its invitation prompt) cannot paint over
        // the picker; out of flow, so the header row gains no gap.
        <div className="absolute z-60">
          <QuickOpenDialog
            isApple={isApple}
            onChoose={choose}
            onDismiss={dismiss}
            returnFocusTo={returnFocusRef}
          />
        </div>
      ) : null}
    </>
  );
}
