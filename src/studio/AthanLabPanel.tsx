import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  athanLabErrorOf,
  athanLabVoiceSampleUrl,
  invalidateAthanLabAccount,
  signInUrl,
  useAthanLabKey,
  useAthanLabUsage,
  useAthanLabVoices,
  useRemoveAthanLabKey,
  useSaveAthanLabKey,
  type AthanLabError,
  type AthanLabKeyStatus,
  type AthanLabUsageReport,
  type AthanLabVoice,
  type AthanLabVoiceList,
} from "@next-editor/infra";

/**
 * AthanLab narration setup inside the Studio render panel: connect the user's
 * own AthanLab API key, pick the one voice every dialog keeps, and see the
 * remaining balance. The key goes to the Worker once, on save; the Worker
 * stores it encrypted and only ever answers with its last four characters,
 * because AthanLab's terms forbid using a key from a browser.
 *
 * StudioController renders with the voice this panel reports, and keeps Start
 * render disabled while the panel reports a reason it is not ready.
 */

const ATHANLAB_VOICE_KEY = "next-editor:studio:athanlab-voice";
const ATHANLAB_DASHBOARD_URL = "https://athanlab.com/dashboard/api";
/** Worker codes meaning the saved key itself is unusable — the key status is out of date. */
const UNUSABLE_KEY_CODES = new Set(["key_invalid", "key_stale", "key_missing"]);

function readStoredVoiceId(): string | null {
  try {
    return localStorage.getItem(ATHANLAB_VOICE_KEY);
  } catch {
    return null;
  }
}

function storeVoiceId(voiceId: string): void {
  try {
    localStorage.setItem(ATHANLAB_VOICE_KEY, voiceId);
  } catch {
    // Storage unavailable — the choice still holds until reload.
  }
}

/** Official AthanLab voices first, then the user's own library. */
function orderedVoices(voices: AthanLabVoice[]): AthanLabVoice[] {
  return [
    ...voices.filter((voice) => voice.source === "athanlab"),
    ...voices.filter((voice) => voice.source !== "athanlab"),
  ];
}

/** The stored choice while AthanLab still lists it, else the default voice, else the first official one. */
function resolveVoice(
  list: AthanLabVoiceList | null,
  preferredVoiceId: string | null,
): AthanLabVoice | null {
  if (!list) return null;
  return (
    list.voices.find((voice) => voice.id === preferredVoiceId) ??
    list.voices.find((voice) => voice.id === list.defaultVoiceId) ??
    list.voices.find((voice) => voice.source === "athanlab") ??
    null
  );
}

/** Why AthanLab would refuse a job right now, as far as the usage report tells. */
function usageBlockOf(usage: AthanLabUsageReport | null): string | null {
  if (!usage) return null;
  if (usage.entitled === false) {
    return "Your AthanLab plan cannot create narration jobs — AthanLab's API needs the Max plan.";
  }
  if (usage.spendable === 0) {
    return "Your AthanLab balance is empty — there are no characters left for narration.";
  }
  if (usage.key.remaining === 0) {
    return "This key's monthly character budget is used up.";
  }
  return null;
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

function balanceLineOf(usage: AthanLabUsageReport): string | null {
  if (usage.spendable === null) return null;
  const parts = [`${usage.spendable.toLocaleString()} characters left`];
  const resetsAt = formatDate(usage.monthly.resetsAt);
  if (resetsAt) parts.push(`monthly allowance resets ${resetsAt}`);
  if (usage.key.remaining !== null) {
    parts.push(`key budget: ${usage.key.remaining.toLocaleString()} left`);
  }
  return parts.join(" · ");
}

interface ReadinessInput {
  capabilitiesLoading: boolean;
  signedIn: boolean;
  capabilityAvailable: boolean;
  keyStatus: AthanLabKeyStatus | null;
  keyError: AthanLabError | null;
  voiceList: AthanLabVoiceList | null;
  voicesError: AthanLabError | null;
  selectedVoice: AthanLabVoice | null;
  usage: AthanLabUsageReport | null;
}

/** Null when a render can start; otherwise the reason it cannot, shown beside Start render. */
function notReadyReasonOf(input: ReadinessInput): string | null {
  if (input.capabilitiesLoading) return "Checking whether AthanLab narration is available…";
  if (!input.signedIn) return "Sign in to connect your AthanLab API key.";
  if (!input.capabilityAvailable) return "AthanLab narration is not available on this server yet.";
  if (input.keyError) return input.keyError.message;
  if (!input.keyStatus) return "Checking your AthanLab key…";
  if (input.keyStatus.invalid) return "AthanLab rejected your saved key — connect a new one.";
  if (input.keyStatus.stale)
    return "Your saved AthanLab key can no longer be read — connect it again.";
  if (!input.keyStatus.connected) return "Connect your AthanLab API key first.";
  if (input.voicesError) return input.voicesError.message;
  if (!input.voiceList) return "Loading AthanLab voices…";
  if (!input.selectedVoice) return "No AthanLab voice is available — refresh the voice list.";
  return usageBlockOf(input.usage);
}

export interface AthanLabPanelProps {
  userId: string | null;
  /** The server can store AthanLab keys (`/api/studio/capabilities`). */
  capabilityAvailable: boolean;
  capabilitiesLoading: boolean;
  /** A render or a voice task is running. */
  disabled: boolean;
  /** The voice dialogs are synthesized with, or null when there is none to use. */
  onVoiceChange: (voiceId: string | null, voiceName: string | null) => void;
  onReadyChange: (ready: boolean, reason: string | null) => void;
}

const BUTTON_CLASS =
  "shrink-0 rounded-md bg-[#222d3b] px-2.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] disabled:cursor-not-allowed disabled:opacity-50";
const LINK_CLASS = "text-[#8db8ef] underline underline-offset-2 hover:text-sky-200";

export default function AthanLabPanel({
  userId,
  capabilityAvailable,
  capabilitiesLoading,
  disabled,
  onVoiceChange,
  onReadyChange,
}: AthanLabPanelProps) {
  const enabled = userId !== null && capabilityAvailable && !capabilitiesLoading;
  const keyQuery = useAthanLabKey(userId, enabled);
  const keyStatus = enabled ? (keyQuery.data ?? null) : null;
  const connected = keyStatus?.connected === true;
  const voicesQuery = useAthanLabVoices(userId, enabled && connected);
  const usageQuery = useAthanLabUsage(userId, enabled && connected);
  const saveKey = useSaveAthanLabKey(userId);
  const removeKey = useRemoveAthanLabKey(userId);
  const queryClient = useQueryClient();

  const [preferredVoiceId, setPreferredVoiceId] = useState<string | null>(readStoredVoiceId);
  const [formOpen, setFormOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [saveError, setSaveError] = useState<AthanLabError | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  const [samplePlaying, setSamplePlaying] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const sampleAudioRef = useRef<HTMLAudioElement | null>(null);

  const voiceList = connected ? (voicesQuery.data ?? null) : null;
  const voices = voiceList ? orderedVoices(voiceList.voices) : [];
  const selectedVoice = resolveVoice(voiceList, preferredVoiceId);
  const usage = connected ? usageQuery.data : undefined;
  const usageReport = usage && usage.available !== false ? usage : null;
  const usageBlock = usageBlockOf(usageReport);
  const balanceLine = usageReport ? balanceLineOf(usageReport) : null;

  // A failed refetch keeps showing the last good answer; only a query that
  // never produced one reports its error.
  const keyError =
    enabled && keyQuery.data === undefined && keyQuery.error
      ? athanLabErrorOf(keyQuery.error)
      : null;
  const voicesError =
    connected && voicesQuery.data === undefined && voicesQuery.error
      ? athanLabErrorOf(voicesQuery.error)
      : null;
  const notReadyReason = notReadyReasonOf({
    capabilitiesLoading,
    signedIn: userId !== null,
    capabilityAvailable,
    keyStatus,
    keyError,
    voiceList,
    voicesError,
    selectedVoice,
    usage: usageReport,
  });

  // The voice list or the balance can be the first to learn that AthanLab
  // revoked the key (a render's 401 marks it server-side); re-read the key
  // status then, which flips this panel to the connect form.
  const keyReportedUnusable =
    connected &&
    [voicesQuery.error, usageQuery.error].some(
      (error) => error !== null && UNUSABLE_KEY_CODES.has(athanLabErrorOf(error).code ?? ""),
    );
  useEffect(() => {
    if (keyReportedUnusable && userId !== null) {
      void invalidateAthanLabAccount(queryClient, userId);
    }
  }, [keyReportedUnusable, userId]);

  const selectedVoiceId = selectedVoice?.id ?? null;
  const selectedVoiceName = selectedVoice?.name ?? null;
  useEffect(() => {
    onVoiceChange(selectedVoiceId, selectedVoiceName);
  }, [selectedVoiceId, selectedVoiceName]);

  useEffect(() => {
    onReadyChange(notReadyReason === null, notReadyReason);
  }, [notReadyReason]);

  useEffect(
    () => () => {
      sampleAudioRef.current?.pause();
    },
    [],
  );

  const chooseVoice = (voiceId: string) => {
    setPreferredVoiceId(voiceId);
    storeVoiceId(voiceId);
  };

  const saveDraftKey = () => {
    const apiKey = keyDraft.trim();
    if (!apiKey || saveKey.isPending) return;
    setSaveError(null);
    setRemoved(false);
    saveKey
      .mutateAsync(apiKey)
      .then(() => setFormOpen(false))
      .catch((error: unknown) => setSaveError(athanLabErrorOf(error)))
      .finally(() => {
        // The key has left the page with this request: drop it from the field
        // and, through reset(), from the settled mutation's variables.
        setKeyDraft("");
        saveKey.reset();
      });
  };

  const disconnect = () => {
    if (
      !window.confirm(
        "Disconnect your AthanLab key? Next Editor deletes its encrypted copy; AthanLab narration stops until you connect a key again.",
      )
    ) {
      return;
    }
    setRemoveError(null);
    removeKey
      .mutateAsync()
      .then(() => {
        setRemoved(true);
        setFormOpen(false);
        setSaveError(null);
      })
      .catch((error: unknown) => setRemoveError(athanLabErrorOf(error).message));
  };

  const toggleSample = () => {
    sampleAudioRef.current?.pause();
    if (samplePlaying) {
      sampleAudioRef.current = null;
      setSamplePlaying(false);
      return;
    }
    if (!selectedVoice) return;
    const audio = new Audio(athanLabVoiceSampleUrl(selectedVoice.id));
    sampleAudioRef.current = audio;
    setSampleError(null);
    setSamplePlaying(true);
    const settle = (failed: boolean) => {
      // A newer sample (or Stop) has taken over; this one's events are stale.
      if (sampleAudioRef.current !== audio) return;
      sampleAudioRef.current = null;
      setSamplePlaying(false);
      if (failed) setSampleError("Could not play this voice's sample — try again.");
    };
    audio.onended = () => settle(false);
    audio.onerror = () => settle(true);
    audio.play().catch(() => settle(true));
  };

  if (capabilitiesLoading) {
    return (
      <p className="mt-2 text-[12px] text-slate-400">
        Checking whether AthanLab narration is available…
      </p>
    );
  }

  if (userId === null) {
    return (
      <p className="mt-2 text-[12px] text-amber-300">
        <a
          href={signInUrl(window.location.pathname + window.location.search)}
          className={LINK_CLASS}
        >
          Sign in
        </a>{" "}
        to connect your AthanLab API key.
      </p>
    );
  }

  if (!capabilityAvailable) {
    return (
      <p className="mt-2 text-[12px] text-amber-300">
        AthanLab narration is not available on this server yet.
      </p>
    );
  }

  if (!keyStatus) {
    return keyError ? (
      <div className="mt-2 flex items-center gap-2 text-[12px] text-rose-300">
        <p className="min-w-0 flex-1">{keyError.message}</p>
        <button
          type="button"
          disabled={keyQuery.isFetching}
          onClick={() => {
            void keyQuery.refetch();
          }}
          className={BUTTON_CLASS}
        >
          Retry
        </button>
      </div>
    ) : (
      <p className="mt-2 text-[12px] text-slate-400">Checking your AthanLab key…</p>
    );
  }

  const showForm = !connected || formOpen;
  const hasSavedRow = connected || keyStatus.invalid === true || keyStatus.stale === true;

  return (
    <div className="mt-2 space-y-1.5 text-[12px] text-slate-300">
      {connected ? (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1">
            AthanLab key <span className="font-mono text-slate-100">{keyStatus.hint}</span>
          </p>
          {formOpen ? null : (
            <button
              type="button"
              disabled={disabled || removeKey.isPending}
              onClick={() => {
                setSaveError(null);
                setFormOpen(true);
              }}
              className={BUTTON_CLASS}
            >
              Change
            </button>
          )}
        </div>
      ) : null}

      {keyStatus.invalid ? (
        <p className="text-amber-300">
          AthanLab rejected your saved key (<span className="font-mono">{keyStatus.hint}</span>) —
          it may have expired or been revoked.
        </p>
      ) : null}
      {keyStatus.stale ? (
        <p className="text-amber-300">Your saved key can no longer be read — connect it again.</p>
      ) : null}
      {removed && !hasSavedRow ? (
        <p className="text-slate-400">
          Also revoke this key in your{" "}
          <a
            href={ATHANLAB_DASHBOARD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK_CLASS}
          >
            AthanLab dashboard
          </a>
          .
        </p>
      ) : null}

      {showForm ? (
        <div>
          <div className="flex items-center gap-2">
            {/* ph-no-capture keeps the field out of PostHog session replays
                regardless of the global maskAllInputs setting, like the agent's
                OpenRouter key field (AgentSettingsDialog). */}
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={keyDraft}
              disabled={disabled || saveKey.isPending}
              onChange={(event) => setKeyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  saveDraftKey();
                }
              }}
              placeholder={connected ? "ak_live_… (paste to replace)" : "ak_live_…"}
              aria-label="AthanLab API key"
              className="ph-no-capture min-w-0 flex-1 rounded-md border border-slate-700 bg-[#151a22] px-2 py-1.5 font-mono text-[12px] text-slate-200 outline-none focus:border-slate-500 disabled:opacity-50"
            />
            <button
              type="button"
              disabled={disabled || saveKey.isPending || keyDraft.trim() === ""}
              onClick={saveDraftKey}
              className="shrink-0 rounded-md bg-[#173925] px-2.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-[#58d88d] transition-colors hover:bg-[#1f4a31] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saveKey.isPending ? "Checking…" : "Save"}
            </button>
            {connected ? (
              <button
                type="button"
                disabled={saveKey.isPending}
                onClick={() => {
                  setKeyDraft("");
                  setSaveError(null);
                  setFormOpen(false);
                }}
                className="shrink-0 rounded-md px-2 py-1.5 text-[12px] font-semibold text-slate-400 hover:text-white disabled:opacity-50"
              >
                Cancel
              </button>
            ) : null}
          </div>
          {saveError ? <p className="mt-1 text-rose-300">{saveError.message}</p> : null}
          <p className="mt-1 text-slate-500">
            Get a key at{" "}
            <a
              href={ATHANLAB_DASHBOARD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={LINK_CLASS}
            >
              athanlab.com/dashboard/api
            </a>{" "}
            (developer access is invite-only and needs the Max plan). Create a dedicated key for
            Next Editor with only <span className="font-mono">speech:write</span>,{" "}
            <span className="font-mono">speech:read</span>,{" "}
            <span className="font-mono">voices:read</span> (and optionally{" "}
            <span className="font-mono">usage:read</span>), a monthly character budget and a short
            expiry.
          </p>
        </div>
      ) : null}

      {hasSavedRow ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={disabled || removeKey.isPending || saveKey.isPending}
            onClick={disconnect}
            className="shrink-0 rounded-md bg-[#3b2222] px-2.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-[#ef8d8d] transition-colors hover:bg-[#4d2a2a] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {removeKey.isPending ? "Disconnecting…" : "Disconnect"}
          </button>
          {removeError ? <p className="min-w-0 flex-1 text-rose-300">{removeError}</p> : null}
        </div>
      ) : null}

      {connected ? (
        <div>
          <div className="flex items-center gap-2">
            <select
              value={selectedVoice?.id ?? ""}
              disabled={disabled || voices.length === 0}
              onChange={(event) => chooseVoice(event.target.value)}
              aria-label="AthanLab voice"
              className="min-w-0 flex-1 rounded-md border border-slate-700 bg-[#151a22] px-2 py-1.5 font-mono text-[12px] text-slate-200 disabled:opacity-50"
            >
              {voices.length === 0 ? (
                <option value="">
                  {voicesQuery.isFetching ? "voice: loading…" : "voice: none available"}
                </option>
              ) : null}
              {voices.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  voice: {voice.name}
                  {voice.source === "user" ? " (your library)" : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={disabled || voicesQuery.isFetching || usageQuery.isFetching}
              onClick={() => {
                void Promise.all([voicesQuery.refetch(), usageQuery.refetch()]);
              }}
              aria-label="Refresh AthanLab voices and balance"
              title="Reload the voice list and your balance from AthanLab"
              className={BUTTON_CLASS}
            >
              ↻
            </button>
            <button
              type="button"
              disabled={disabled || (!samplePlaying && !selectedVoice)}
              onClick={toggleSample}
              title="Play AthanLab's free sample of this voice"
              className={BUTTON_CLASS}
            >
              {samplePlaying ? "Stop" : "Listen"}
            </button>
          </div>
          {voicesError ? <p className="mt-1 text-rose-300">{voicesError.message}</p> : null}
          {sampleError ? <p className="mt-1 text-rose-300">{sampleError}</p> : null}
          {balanceLine ? <p className="mt-1 text-slate-400">{balanceLine}</p> : null}
          {usageBlock ? (
            <p className="mt-1 text-amber-300">
              {usageBlock}
              {usageReport?.upgradeUrl ? (
                <>
                  {" "}
                  <a
                    href={usageReport.upgradeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={LINK_CLASS}
                  >
                    Upgrade on AthanLab
                  </a>
                </>
              ) : null}{" "}
              <button
                type="button"
                disabled={disabled || usageQuery.isFetching}
                onClick={() => {
                  void usageQuery.refetch();
                }}
                className={`${LINK_CLASS} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {usageQuery.isFetching ? "Checking…" : "Check again"}
              </button>
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="text-slate-400">
        Each dialog that is not cached yet is one AthanLab job, charged to your AthanLab balance at
        AthanLab's rates. Finished dialogs are cached in this browser, so rendering again does not
        pay for them twice. AthanLab keeps each job's text and audio for 30 days. Your key is stored
        encrypted on Next Editor's server, used only for your own narration jobs, and never shown
        again. The LessonScript must use{" "}
        <span className="font-mono text-slate-300">locale: my-MM</span>; place{" "}
        <span className="font-mono text-slate-300">[[mark:…]]</span> at sentence ends for the most
        natural AthanLab intonation.
      </p>
    </div>
  );
}
