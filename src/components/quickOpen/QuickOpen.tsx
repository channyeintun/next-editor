import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useSelector } from "@xstate/store-react";
import { useNextEditorActions, useNextEditorMetadata } from "../../hooks/useNextEditorContext";
import { useIsWorkspaceCovered } from "../../hooks/useIsWorkspaceCovered";
import { useOpenWorkspaceFile } from "../../hooks/useOpenWorkspaceFile";
import type { WorkspaceTreeFile } from "../../types/workspace";
import { isApplePlatform } from "../../utils/keyboardPlatform";
import { isProductTourActive } from "../tour/productTour";
import { EDITOR_MAIN_ID } from "../editorTabFocus";
import { isGoToFileShortcut } from "./goToFileShortcut";
import QuickOpenDialog from "./QuickOpenDialog";
import {
  GO_TO_FILE_BUTTON_ID,
  quickOpenStore,
  useIsQuickOpenShowing,
  useOpenQuickOpen,
} from "./quickOpenState";

/**
 * Go to File's picker and the Cmd+P / Ctrl+P that opens it from anywhere in
 * the editor. Mounted in the editor header, so the key works while the file
 * explorer (which holds the button) is collapsed. While the picker is open a
 * lesson stays paused.
 */
export default function QuickOpen() {
  const [isApple] = useState(isApplePlatform);
  const isOpen = useSelector(quickOpenStore, (state) => state.context.isOpen);
  // Keyed by time, so opening the same file twice is announced twice.
  const [announcement, setAnnouncement] = useState<{ text: string; at: number } | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const isCovered = useIsWorkspaceCovered();
  const isShowing = useIsQuickOpenShowing();
  const isPlaying = useNextEditorMetadata((metadata) => metadata.isPlaying);
  const { pause, editorRef } = useNextEditorActions();
  const openWorkspaceFile = useOpenWorkspaceFile();
  const open = useOpenQuickOpen();

  // Cancelled, the picker gives focus back to whatever opened it.
  useEffect(() => {
    if (isOpen) returnFocusRef.current = null;
  }, [isOpen]);

  // A deck or the whiteboard drawn over the workspace closes the picker under it.
  useEffect(() => {
    if (isCovered) quickOpenStore.trigger.closed();
  }, [isCovered]);

  // Whatever starts playback while the picker is up (autoplay finishing a
  // load, a playlist moving on) is paused again.
  useEffect(() => {
    if (isShowing && isPlaying) pause();
  }, [isShowing, isPlaying, pause]);

  // Leaving the editor with the picker open must not reopen it on return.
  useEffect(() => () => quickOpenStore.trigger.closed(), []);

  const dismiss = () => {
    // An opener that closed under the picker (the file explorer's context
    // menu, which the picker's field blurs shut, or the explorer itself)
    // cannot take focus back: the button can, else the editor region.
    if (!quickOpenStore.getSnapshot().context.opener?.isConnected) {
      returnFocusRef.current =
        document.getElementById(GO_TO_FILE_BUTTON_ID) ?? document.getElementById(EDITOR_MAIN_ID);
    }
    quickOpenStore.trigger.closed();
  };

  const choose = (file: WorkspaceTreeFile) => {
    // Focus lands on the editor region as the dialog closes, then moves into
    // Monaco once it shows the new file. Monaco's label names the file, so a
    // screen reader hears the switch. An image, video or audio file has no
    // editor, and a full-height runtime dock hides it; then the switch is
    // announced instead.
    returnFocusRef.current = document.getElementById(EDITOR_MAIN_ID);
    openWorkspaceFile(file.path);
    quickOpenStore.trigger.closed();
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

  return (
    <>
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
