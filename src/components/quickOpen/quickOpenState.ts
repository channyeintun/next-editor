import { createStore, useSelector } from "@xstate/store-react";
import { useIsWorkspaceCovered } from "../../hooks/useIsWorkspaceCovered";
import { useNextEditorActions } from "../../hooks/useNextEditorContext";

/**
 * Whether Go to File is open. The picker and its Cmd+P / Ctrl+P live in the
 * editor header (QuickOpen), which is always mounted; its button sits in the
 * file explorer's header, which unmounts while the explorer is collapsed.
 * `opener` is what had focus when it opened, for focus to go back to.
 */
export const quickOpenStore = createStore({
  context: { isOpen: false, opener: null as HTMLElement | null },
  on: {
    opened: (context, event: { opener: HTMLElement | null }) => ({
      ...context,
      isOpen: true,
      opener: event.opener,
    }),
    closed: (context) => (context.isOpen ? { ...context, isOpen: false, opener: null } : context),
  },
});

/** The button's id, for focus to land on when the picker's opener is gone. */
export const GO_TO_FILE_BUTTON_ID = "go-to-file-button";

/** Open, and not hidden under a deck or the whiteboard drawn over the workspace. */
export function useIsQuickOpenShowing(): boolean {
  const isOpen = useSelector(quickOpenStore, (state) => state.context.isOpen);
  const isCovered = useIsWorkspaceCovered();
  return isOpen && !isCovered;
}

/**
 * Opens the picker, pausing a playing lesson first, as when the slides open,
 * so the replay cannot switch files or cover the editor under it.
 */
export function useOpenQuickOpen(): () => void {
  const isCovered = useIsWorkspaceCovered();
  const { pause } = useNextEditorActions();
  return () => {
    if (isCovered) return;
    pause();
    const focused = document.activeElement;
    quickOpenStore.trigger.opened({
      opener: focused instanceof HTMLElement && focused !== document.body ? focused : null,
    });
  };
}
