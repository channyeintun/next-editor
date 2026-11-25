import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import HoverRing from "../components/hoverRing/HoverRing";
import { copyTextToClipboard } from "../utils/clipboard";
import { HOWARD_MODEL, HOWARD_START_COMMAND, howardServerUrlOf } from "./tts/howard/protocol";
import {
  fetchHowardServerModel,
  howardServerReportOf,
  howardServerUrl,
  rememberedHowardModel,
  storeHowardServerUrl,
  type HowardServerReport,
} from "./tts/howard/server";

/**
 * Howard narration setup inside the Studio render panel. Howard runs on the
 * author's own computer, as a small server the page calls on the loopback
 * address (tts/howard/). This panel holds that server's address, checks that
 * it answers and which model it loaded, and shows the one command that starts
 * it when it does not. The narrator's voice comes from the reference library
 * below it (NarratorVoicePanel).
 *
 * StudioController keys narration by the model this panel reports, and keeps
 * Start render disabled until a server has named one.
 */

const SETUP_GUIDE_URL =
  "https://github.com/channyeintun/next-editor/blob/main/docs/howard-on-device-burmese.md";
const MODEL_CARD_URL = `https://huggingface.co/${HOWARD_MODEL}`;

const BUTTON_CLASS =
  "shrink-0 rounded-md bg-[#222d3b] px-2.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] disabled:cursor-not-allowed disabled:opacity-50";
const LINK_CLASS = "text-[#8db8ef] underline underline-offset-2 hover:text-sky-200";

export interface HowardPanelProps {
  /** A render or a voice task is running. */
  disabled: boolean;
  /** Called with each settled check of the server, never while the first is running. */
  onServerChange: (report: HowardServerReport) => void;
}

/** How long the Copy button says the command was copied. */
const COPIED_NOTICE_MS = 2_000;

/** The command that starts Howard, with a button that copies it. */
function StartCommand() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="space-y-1">
      <p>Run this in a terminal, then press Check:</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-slate-600 bg-[#151a22] px-2 py-1.5 font-mono text-[11px] text-slate-200">
          {HOWARD_START_COMMAND}
        </code>
        <button
          type="button"
          className={BUTTON_CLASS}
          onClick={() => void copyTextToClipboard(HOWARD_START_COMMAND).then(setCopied)}
        >
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
          <HoverRing />
        </button>
      </div>
      <p className="text-slate-400">
        The first run downloads the model (1.3 GB) and builds its server, which takes a few minutes.
        After that the same command starts it at once.
      </p>
    </div>
  );
}

export default function HowardPanel({ disabled, onServerChange }: HowardPanelProps) {
  const [serverUrl, setServerUrl] = useState(howardServerUrl);
  const [draft, setDraft] = useState(serverUrl);
  const [addressError, setAddressError] = useState<string | null>(null);
  const addressErrorId = useId();

  // Asked again whenever the window regains focus: the author starts the
  // server in a terminal and comes back to this tab.
  const server = useQuery({
    queryKey: ["studio", "howard", "server", serverUrl],
    queryFn: ({ signal }) => fetchHowardServerModel(serverUrl, signal),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
  });
  // A failed check keeps the last answer as `data`; only the status says
  // whether the server answered this time.
  const liveModel = server.status === "success" ? server.data : null;
  const checkError =
    server.status === "error"
      ? server.error instanceof Error
        ? server.error.message
        : String(server.error)
      : null;
  const settled = server.status !== "pending";

  useEffect(() => {
    if (settled) onServerChange(howardServerReportOf(liveModel, checkError));
  }, [settled, liveModel, checkError]);

  const check = () => {
    const parsed = howardServerUrlOf(draft);
    if (!parsed.ok) {
      setAddressError(parsed.error);
      return;
    }
    setAddressError(null);
    setDraft(parsed.url);
    if (parsed.url === serverUrl) {
      void server.refetch();
      return;
    }
    storeHowardServerUrl(parsed.url);
    setServerUrl(parsed.url);
  };

  const keptModel = liveModel === null && settled ? rememberedHowardModel() : null;

  return (
    <div className="mt-2 space-y-1.5 text-[12px] text-slate-300">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          check();
        }}
      >
        <input
          type="text"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Howard server address"
          aria-invalid={addressError !== null}
          aria-describedby={addressError !== null ? addressErrorId : undefined}
          className="min-w-0 flex-1 rounded-md border border-slate-500 bg-[#151a22] px-2 py-1.5 font-mono text-[12px] text-slate-200 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled || server.isFetching}
          className={BUTTON_CLASS}
          title="Ask the Howard server on this computer which model it runs"
        >
          Check
          <HoverRing />
        </button>
      </form>
      {addressError !== null ? (
        <p id={addressErrorId} role="alert" className="text-rose-300">
          {addressError}
        </p>
      ) : null}
      {/* Always mounted, so each answer of the check is announced. */}
      <div role="status">
        {server.isFetching ? (
          <p className="text-slate-400">Checking the Howard server…</p>
        ) : liveModel !== null ? (
          <p>
            Howard is running here: <span className="font-mono text-slate-100">{liveModel}</span>
          </p>
        ) : (
          <>
            <p className="text-amber-300">{checkError}</p>
            {keptModel !== null ? (
              <p className="text-slate-400">
                Lessons already narrated with <span className="font-mono">{keptModel}</span> still
                render from the narration this browser kept.
              </p>
            ) : null}
          </>
        )}
      </div>
      {/* Outside the status region: the command is not an answer to announce. */}
      {settled && !server.isFetching && liveModel === null ? <StartCommand /> : null}
      <p className="text-slate-400">
        <a href={MODEL_CARD_URL} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
          Howard 0.6B
        </a>{" "}
        runs on this computer, not on a service: keep its server running while narration is made (
        <a href={SETUP_GUIDE_URL} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
          setup guide
        </a>
        ). The narrator reference and the lesson text go to that server only. The LessonScript must
        use <span className="font-mono text-slate-300">locale: my-MM</span>.
      </p>
    </div>
  );
}
