import { useEffect, useId, useState, type RefObject } from "react";
import {
  isRuntimeBusy,
  type EnvironmentVariables,
} from "../../contexts/WebContainerRuntimeContext";
import {
  useWebContainerRuntimeActions,
  useWebContainerRuntimeMetadata,
} from "../../hooks/useWebContainerRuntime";
import ModalShell from "../ModalShell";

/** The variables as `KEY=value` lines, sorted by key. */
export function stringifyEnvironmentVariables(variables: EnvironmentVariables): string {
  return Object.entries(variables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/**
 * Reads `KEY=value` lines, skipping blank lines and `#` comments. The first
 * malformed line makes the whole input an error.
 */
export function parseEnvironmentInput(value: string): {
  environmentVariables: EnvironmentVariables;
  errorMessage: string | null;
} {
  const environmentVariables: EnvironmentVariables = {};
  const lines = value.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex <= 0) {
      return {
        environmentVariables: {},
        errorMessage: `Line ${index + 1} must use KEY=value format.`,
      };
    }

    const key = line.slice(0, separatorIndex).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return {
        environmentVariables: {},
        errorMessage: `Line ${index + 1} has an invalid variable name.`,
      };
    }

    environmentVariables[key] = line.slice(separatorIndex + 1);
  }

  return {
    environmentVariables,
    errorMessage: null,
  };
}

interface EnvironmentVariablesDialogProps {
  onClose: () => void;
  /**
   * Where focus goes when the dialog closes: the menu item that opens it
   * unmounts as it does, so it cannot take focus back itself.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Edits the runtime's environment variables as `KEY=value` lines. Saving
 * reruns the runner when it is on and the runtime is not busy.
 */
export default function EnvironmentVariablesDialog({
  onClose,
  returnFocusRef,
}: EnvironmentVariablesDialogProps) {
  const titleId = useId();
  const { rerunRunner, updateEnvironmentVariables } = useWebContainerRuntimeActions();
  const { environmentVariables, runnerConfig, status } = useWebContainerRuntimeMetadata();
  const [draftValue, setDraftValue] = useState(() =>
    stringifyEnvironmentVariables(environmentVariables),
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Variables that change while the dialog is open replace the draft.
  useEffect(() => {
    setDraftValue(stringifyEnvironmentVariables(environmentVariables));
    setErrorMessage(null);
  }, [environmentVariables]);

  const handleSave = () => {
    const parsed = parseEnvironmentInput(draftValue);

    if (parsed.errorMessage) {
      setErrorMessage(parsed.errorMessage);
      return;
    }

    updateEnvironmentVariables(parsed.environmentVariables);
    onClose();

    if (runnerConfig.enabled && !isRuntimeBusy(status)) {
      void rerunRunner();
    }
  };

  return (
    <ModalShell
      maxWidthClassName="max-w-xl"
      labelledBy={titleId}
      onDismiss={onClose}
      returnFocusTo={returnFocusRef}
    >
      <div className="space-y-5 overflow-y-auto p-5">
        <h2 id={titleId} className="text-sm font-medium text-slate-100">
          Edit Environment
        </h2>

        <label className="block">
          <span className="sr-only">Environment variables</span>
          <textarea
            value={draftValue}
            onChange={(event) => {
              setDraftValue(event.target.value);
              if (errorMessage) {
                setErrorMessage(null);
              }
            }}
            rows={12}
            spellCheck={false}
            className="min-h-64 w-full rounded-lg border border-slate-700 bg-[#11141c] font-mono text-sm leading-6 text-slate-100 outline-none transition-colors focus:border-slate-500 p-3"
            placeholder="API_URL=https://example.com\nNODE_ENV=development"
          />
        </label>

        {errorMessage ? <p className="text-sm text-rose-300">{errorMessage}</p> : null}

        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-400 transition-colors hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded bg-emerald-500 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-950 transition-colors hover:bg-emerald-400"
          >
            Save
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
