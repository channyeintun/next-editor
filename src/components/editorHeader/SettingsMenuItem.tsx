import type { LucideIcon } from "lucide-react";

const SETTINGS_MENU_ITEM_CLASS =
  "w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700 hover:text-white";

interface SettingsMenuItemProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Replaces the standard item classes. */
  className?: string;
}

/** One action in the workspace settings menu: an icon and a label. */
export default function SettingsMenuItem({
  icon: Icon,
  label,
  onClick,
  disabled,
  className = SETTINGS_MENU_ITEM_CLASS,
}: SettingsMenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={className}
    >
      <span className="flex items-center gap-2">
        <Icon size={14} aria-hidden="true" />
        {label}
      </span>
    </button>
  );
}
