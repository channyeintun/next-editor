import { useState } from "react";
import { useNavigate } from "react-router";
import axios from "axios";
import { Check, Pencil, X } from "lucide-react";
import { useUpdateUsername } from "@next-editor/infra";

// Own-profile-only control (see AuthorProfilePage) for renaming the
// signed-in user's own username. On success it navigates to the new
// /learn/@<username> — the old URL 404s from here on, same trade-off every
// username-based profile URL has (GitHub, X, etc.).
export default function UsernameEditor({ username }: { username: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(username);
  const [error, setError] = useState<string | null>(null);
  const mutation = useUpdateUsername();
  const navigate = useNavigate();

  if (!editing) {
    return (
      <div className="mb-4 flex items-center gap-1.5 text-sm text-slate-400">
        <span>@{username}</span>
        <button
          type="button"
          aria-label="Edit username"
          onClick={() => {
            setValue(username);
            setError(null);
            setEditing(true);
          }}
          className="rounded p-1 text-slate-500 transition-colors hover:text-white"
        >
          <Pencil className="size-3.5" />
        </button>
      </div>
    );
  }

  const submit = () => {
    const next = value.trim().toLowerCase();
    if (!next || next === username) {
      setEditing(false);
      return;
    }
    mutation.mutate(next, {
      onSuccess: () => {
        navigate(`/learn/@${next}`, { replace: true });
      },
      onError: (err) => {
        if (axios.isAxiosError(err) && err.response?.status === 409) {
          setError("That username is already taken.");
        } else if (axios.isAxiosError(err) && err.response?.status === 400) {
          setError("Use 3-32 lowercase letters, numbers, and hyphens.");
        } else {
          setError("Couldn't update your username. Try again.");
        }
      },
    });
  };

  return (
    <div className="mb-4 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-500">@</span>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") setEditing(false);
          }}
          disabled={mutation.isPending}
          className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm text-white outline-none focus:border-pinata-purple/60 disabled:opacity-60"
        />
        <button
          type="button"
          aria-label="Save username"
          onClick={submit}
          disabled={mutation.isPending}
          className="rounded p-1 text-slate-400 transition-colors hover:text-white disabled:opacity-50"
        >
          <Check className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Cancel"
          onClick={() => setEditing(false)}
          disabled={mutation.isPending}
          className="rounded p-1 text-slate-400 transition-colors hover:text-white disabled:opacity-50"
        >
          <X className="size-4" />
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
