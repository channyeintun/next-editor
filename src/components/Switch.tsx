interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

const Switch: React.FC<SwitchProps> = ({ checked, onChange, label, disabled = false }) => {
  return (
    <label
      className={`flex items-center justify-between gap-3 py-1 ${disabled ? "opacity-50" : "cursor-pointer"}`}
    >
      <span className="text-sm font-medium text-slate-300">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-[#10c776]" : "bg-slate-600"
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
