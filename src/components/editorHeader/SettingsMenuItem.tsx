import type { LucideIcon } from "lucide-react";

/** A settings menu row's shape, shared by every row so the icons line up in one column. */
export const SETTINGS_MENU_ROW_CLASS =
  "group flex w-full items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors";

/** The fixed slot a row's icon sits in: a step quieter than the label, brightening with it. */
export const SETTINGS_MENU_ICON_SLOT_CLASS =
  "flex size-4 shrink-0 items-center justify-center text-slate-400 transition-colors group-hover:text-slate-200 group-aria-expanded:text-slate-200 group-disabled:text-slate-600";

// Greyed out, not just disabled, while there is nothing for it to do.
const SETTINGS_MENU_ITEM_CLASS = `${SETTINGS_MENU_ROW_CLASS} text-slate-200 enabled:hover:bg-slate-700 enabled:hover:text-white disabled:cursor-not-allowed disabled:text-slate-500`;

interface SettingsMenuItemProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

/** One action in the workspace settings menu: an icon and a label. */
export default function SettingsMenuItem({
  icon: Icon,
  label,
  onClick,
  disabled,
}: SettingsMenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={SETTINGS_MENU_ITEM_CLASS}
    >
      <span className={SETTINGS_MENU_ICON_SLOT_CLASS} aria-hidden="true">
        <Icon size={16} />
      </span>
      {label}
    </button>
  );
}
