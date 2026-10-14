import type { LucideIcon } from "lucide-react";
import MenuRowIcon from "./mediaControls/MenuRowIcon";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  /** Shown before the label, in the menu's icon column. */
  icon?: LucideIcon;
}

const Switch: React.FC<SwitchProps> = ({ checked, onChange, label, disabled = false, icon }) => {
  return (
    <label
      className={`group/row flex items-center gap-2.5 px-2.5 py-1.5 ${disabled ? "opacity-50" : "cursor-pointer"}`}
    >
      {icon ? <MenuRowIcon icon={icon} /> : null}
      <span className="flex-1 text-sm font-medium text-slate-200">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-[#10c776]" : "bg-slate-500"
        } ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        <span
          className={`inline-block size-3.5 transform rounded-full bg-white transition-transform ${
            checked ? "translate-x-4.5" : "translate-x-1"
          }`}
        />
      </button>
    </label>
  );
};

export default Switch;
