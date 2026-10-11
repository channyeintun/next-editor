import { useState } from "react";
import { FileSearch } from "lucide-react";
import { isApplePlatform } from "../../utils/keyboardPlatform";
import { goToFileAriaKeyShortcuts, goToFileShortcutLabel } from "./goToFileShortcut";
import { GO_TO_FILE_BUTTON_ID, useIsQuickOpenShowing, useOpenQuickOpen } from "./quickOpenState";

/** Go to File's button in the file explorer's header; the picker is QuickOpen's. */
export default function QuickOpenButton() {
  const [isApple] = useState(isApplePlatform);
  const isShowing = useIsQuickOpenShowing();
  const open = useOpenQuickOpen();

  return (
    <button
      id={GO_TO_FILE_BUTTON_ID}
      type="button"
      aria-label="Go to file"
      aria-haspopup="dialog"
      aria-expanded={isShowing}
      aria-keyshortcuts={goToFileAriaKeyShortcuts(isApple)}
      title={`Go to file (${goToFileShortcutLabel(isApple)})`}
      onClick={open}
      className="inline-flex size-5 items-center justify-center text-slate-400 transition-colors hover:text-white"
    >
      <FileSearch size={14} aria-hidden="true" />
    </button>
  );
}
