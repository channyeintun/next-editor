import { useId, useState, type RefObject } from "react";
import { KeyRound } from "lucide-react";
import ModalShell from "@app/components/ModalShell";
import { analytics } from "@app/utils/analytics";
import { passkeyErrorMessage, usePasskeyList, useRemovePasskey } from "./usePasskey";

function formatDay(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface PasskeyListDialogProps {
  onClose: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
}

/**
 * Every passkey that signs in to this account, with when it was added and
 * last used, and a Remove control for each. This is how the owner finds and
 * removes a passkey they did not add, or one left on a shared computer.
 */
export default function PasskeyListDialog({ onClose, returnFocusTo }: PasskeyListDialogProps) {
  const titleId = useId();
  const { passkeys, isLoading } = usePasskeyList();
  const remove = useRemovePasskey();
  const [error, setError] = useState<string | null>(null);
  const removingId = remove.isPending ? remove.variables : undefined;

  return (
    <ModalShell
      maxWidthClassName="max-w-md"
      labelledBy={titleId}
      onDismiss={onClose}
      returnFocusTo={returnFocusTo}
    >
      <div className="space-y-5 overflow-y-auto p-5">
        <div className="space-y-1">
          <h2 id={titleId} className="text-sm font-medium text-slate-100">
            Your passkeys
          </h2>
          <p className="text-xs text-slate-400">
            Each one signs in to this account on its own. Remove any you don't recognize. Your
            device may still list a removed passkey, but it can no longer sign in.
          </p>
        </div>

        {isLoading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : passkeys.length === 0 ? (
          <p className="text-sm text-slate-400">This account has no passkeys.</p>
        ) : (
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
            {passkeys.map((passkey, index) => (
              <li key={passkey.id} className="flex items-center gap-3 p-3">
                <KeyRound className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
                <div className="min-w-0 flex-1 text-sm">
                  <p className="text-slate-100">Passkey {index + 1}</p>
                  <p className="text-xs text-slate-400">
                    Added {formatDay(passkey.createdAt)} ·{" "}
                    {passkey.lastUsedAt
                      ? `last used ${formatDay(passkey.lastUsedAt)}`
                      : "never used to sign in"}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={`Remove passkey ${index + 1}`}
                  disabled={remove.isPending}
                  onClick={() => {
                    setError(null);
                    remove.mutate(passkey.id, {
                      onSuccess: () => analytics.capture("passkey_removed"),
                      onError: (err) =>
                        setError(passkeyErrorMessage(err, "Couldn't remove the passkey.")),
                    });
                  }}
                  className="rounded px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-rose-300 transition-colors hover:bg-white/10 hover:text-rose-200 disabled:opacity-60"
                >
                  {removingId === passkey.id ? "Removing…" : "Remove"}
                </button>
              </li>
            ))}
          </ul>
        )}

        {error ? (
          <p role="alert" className="text-sm text-rose-300">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-400 transition-colors hover:text-white"
          >
            Done
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
