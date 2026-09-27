import { useState } from "react";
import { ChevronRight, LayoutTemplate } from "lucide-react";
import type { WorkspaceLessonType } from "../../types/workspace";

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
        onClick={() => setIsOpen((current) => !current)}
        className={`flex w-full items-center justify-between gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors ${
          isOpen ? "bg-slate-700 text-white" : "text-slate-200 hover:bg-slate-700 hover:text-white"
        }`}
      >
        <span className="flex items-center gap-2">
          <LayoutTemplate size={14} aria-hidden="true" />
          Starter Template
        </span>
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={isOpen ? "text-slate-300" : "text-slate-500"}
        />
      </button>

      {isOpen ? (
        // Flush against the parent (no horizontal gap) so the cursor can
        // travel into the flyout without crossing a dead zone that would
        // trip the wrapper's onMouseLeave and close it.
        <div
          role="menu"
          aria-label="Starter templates"
          className="absolute right-full top-0 z-2147483647 w-52 rounded-xl border border-slate-700 bg-[#151821] p-1 shadow-[0_18px_40px_rgba(2,6,23,0.45)]"
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
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-slate-700 text-white"
                    : "text-slate-200 hover:bg-slate-700 hover:text-white"
                }`}
              >
                <span>{option.label}</span>
                {isActive ? (
                  <span className="rounded-full bg-slate-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-200">
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
