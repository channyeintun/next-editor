import { useState } from "react";
import { ChevronRight, LayoutTemplate } from "lucide-react";
import type { WorkspaceLessonType } from "../../types/workspace";
import { SETTINGS_MENU_ICON_SLOT_CLASS, SETTINGS_MENU_ROW_CLASS } from "./SettingsMenuItem";

export interface LessonTypeOption {
  value: WorkspaceLessonType;
  label: string;
}

interface StarterTemplateSubmenuProps {
  /**
   * Whether the entry shows. The settings menu renders this component for as
   * long as it is open, hidden or not, so the flyout's open state lasts exactly
   * as long as the menu: it survives the entry being hidden and shown again,
   * and it is gone the next time the menu opens.
   */
  isVisible: boolean;
  options: readonly LessonTypeOption[];
  activeLessonType: WorkspaceLessonType;
  onSelect: (lessonType: WorkspaceLessonType) => void;
}

/** The settings menu's "Starter Template" entry and its flyout of lesson types. */
export default function StarterTemplateSubmenu({
  isVisible,
  options,
  activeLessonType,
  onSelect,
}: StarterTemplateSubmenuProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (!isVisible) {
    return null;
  }

  return (
    <div
      className="relative"
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        // A pointer or touch click (detail >= 1) only opens: the hover just
        // before it already did, so toggling would shut the flyout under the
        // pointer. Enter or Space (detail 0) toggles, so the keyboard can close it.
        onClick={(event) => setIsOpen((current) => (event.detail === 0 ? !current : true))}
        className={`${SETTINGS_MENU_ROW_CLASS} ${
          isOpen ? "bg-slate-700 text-white" : "text-slate-200 hover:bg-slate-700 hover:text-white"
        }`}
      >
        <span className={SETTINGS_MENU_ICON_SLOT_CLASS} aria-hidden="true">
          <LayoutTemplate size={16} />
        </span>
        Starter Template
        <ChevronRight
          size={16}
          aria-hidden="true"
          className={`ml-auto shrink-0 ${isOpen ? "text-slate-300" : "text-slate-500"}`}
        />
      </button>

      {isOpen ? (
        // Flush against the parent (no horizontal gap) so the cursor can
        // travel into the flyout without crossing a dead zone that would
        // trip the wrapper's onMouseLeave and close it.
        <div
          role="menu"
          aria-label="Starter templates"
          className="absolute right-full top-0 z-2147483647 w-64 rounded-xl border border-slate-700 bg-[#151821] p-1 shadow-[0_18px_40px_rgba(2,6,23,0.45)]"
        >
          {options.map((option) => {
            const isActive = option.value === activeLessonType;

            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => onSelect(option.value)}
                className={`${SETTINGS_MENU_ROW_CLASS} justify-between ${
                  isActive
                    ? "bg-slate-700 text-white"
                    : "text-slate-200 hover:bg-slate-700 hover:text-white"
                }`}
              >
                <span>{option.label}</span>
                {isActive ? (
                  <span className="rounded-full bg-slate-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-white">
                    Active
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
