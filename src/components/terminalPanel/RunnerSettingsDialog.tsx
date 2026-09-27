import type { RunnerConfig } from "../../contexts/WebContainerRuntimeContext";
import ModalShell from "../ModalShell";

interface RunnerToggleProps {
  checked: boolean;
  description?: string;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

function RunnerToggle({
  checked,
  description,
  disabled = false,
  label,
  onChange,
}: RunnerToggleProps) {
  return (
    <label className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-100">{label}</p>
        {description ? (
          <p className="mt-1 text-xs leading-5 text-slate-400">{description}</p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? "bg-[#10c776]" : "bg-slate-700"
        } disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <span
          className={`absolute top-1 rounded-full bg-white transition-transform size-4 ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    </label>
  );
}

interface RunnerCommandFieldProps {
  label: string;
  description: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

function RunnerCommandField({
  label,
  description,
  value,
  disabled,
  onChange,
}: RunnerCommandFieldProps) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-slate-100">{label}</span>
      <input
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 h-11 w-full rounded-lg border border-slate-700 bg-[#11141c] px-3 font-mono text-sm text-slate-100 outline-none transition-colors focus:border-slate-500 disabled:cursor-default disabled:opacity-70"
      />
      <span className="mt-2 block text-xs text-slate-500">{description}</span>
    </label>
  );
}

interface RunnerSettingsDialogProps {
  runnerConfig: RunnerConfig;
  /**
   * Set while a recording plays back: the dialog then mirrors the recording, so
   * nothing in it can be changed and a click on the backdrop does not close it.
   */
  isReadOnly: boolean;
  onChange: (config: Partial<RunnerConfig>) => void;
  onClose: () => void;
}

/** The runner dock's settings: when the runner runs, and the commands it runs. */
export default function RunnerSettingsDialog({
  runnerConfig,
  isReadOnly,
  onChange,
  onClose,
}: RunnerSettingsDialogProps) {
  return (
    <ModalShell
      maxWidthClassName="max-w-md"
      onBackdropClick={() => {
        if (!isReadOnly) {
          onClose();
        }
      }}
    >
      <div className="space-y-5 overflow-y-auto p-5">
        <RunnerToggle
          checked={runnerConfig.enabled}
          disabled={isReadOnly}
          label="Enable Runner"
          onChange={(checked) => onChange({ enabled: checked })}
        />
        <RunnerToggle
          checked={runnerConfig.runOnStartup}
          disabled={isReadOnly}
          label="Run on startup"
          description="Execute script immediately when opening the project"
          onChange={(checked) => onChange({ runOnStartup: checked })}
        />
        <RunnerToggle
          checked={runnerConfig.runOnFileSave}
          disabled={isReadOnly}
          label="Run on file-save"
          description="Execute script when saving a file"
          onChange={(checked) => onChange({ runOnFileSave: checked })}
        />
        <RunnerCommandField
          label="Init Command"
          description="Shell command to run when booting the project"
          value={runnerConfig.initCommand}
          disabled={isReadOnly}
          onChange={(initCommand) => onChange({ initCommand })}
        />
        <RunnerCommandField
          label="Run Command"
          description="Shell command to run inside the workspace"
          value={runnerConfig.runCommand}
          disabled={isReadOnly}
          onChange={(runCommand) => onChange({ runCommand })}
        />
      </div>
    </ModalShell>
  );
}
