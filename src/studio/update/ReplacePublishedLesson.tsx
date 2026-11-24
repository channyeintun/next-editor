import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Replace } from "lucide-react";
import { formatDuration } from "../../../infra/client/upload/uploadLesson";
import type { StudioRunArtifacts } from "../runStudioRender";
import type {
  StudioAutomationLessonChange,
  StudioAutomationLessonMatch,
} from "../studioWindowHandle";
import { findPublishedLesson, replacePublishedLesson } from "./publishedLessonUpdate";

type FoundLesson = Extract<StudioAutomationLessonMatch, { found: unknown }>["found"];

type Step =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "compared"; lesson: FoundLesson; change: StudioAutomationLessonChange }
  | { kind: "replacing"; lesson: FoundLesson; fraction: number | null }
  | {
      kind: "replaced";
      lesson: FoundLesson;
      change: StudioAutomationLessonChange;
      audioFile: string;
      removedAudioFile: string | null;
    }
  | { kind: "refused"; message: string };

const QUIET_BUTTON =
  "inline-flex items-center gap-1.5 rounded-md bg-[#222d3b] px-3 py-1.5 font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] disabled:cursor-not-allowed disabled:opacity-50";
const CONFIRM_BUTTON =
  "rounded-md bg-[#3b2a22] px-3 py-1.5 font-bold uppercase tracking-[0.04em] text-[#efb28d] transition-colors hover:bg-[#4d382a] disabled:cursor-not-allowed disabled:opacity-50";

function LessonChangeSummary({
  lesson,
  change,
}: {
  lesson: FoundLesson;
  change: StudioAutomationLessonChange;
}) {
  return (
    <div className="text-[12px] text-slate-300">
      <p>
        <span className="font-semibold">{lesson.title}</span>{" "}
        <span className="font-mono text-slate-400">{lesson.urlSlug}</span>{" "}
        <span className="text-slate-400">({lesson.status})</span>
      </p>
      <p className="mt-0.5 text-slate-400">
        {change.changedCues} of {change.totalCues} caption cues differ. Length{" "}
        {formatDuration(change.publishedDurationMs)} now, {formatDuration(change.newDurationMs)}{" "}
        after.
      </p>
      {change.examples.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-slate-400">
          {change.examples.map((example) => (
            <li key={example} className="break-words">
              {example}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The results panel's way to put a passing run in place of the lesson it was
 * published as. The first click only finds the lesson and says what would
 * change; nothing is replaced until the person presses the second button,
 * which names the lesson.
 */
export function ReplacePublishedLesson({
  title,
  artifacts,
}: {
  title: string;
  artifacts: StudioRunArtifacts;
}) {
  const queryClient = useQueryClient();
  // The step belongs to one run; a newer run starts again from the button.
  const [state, setState] = useState<{ artifacts: StudioRunArtifacts; step: Step }>({
    artifacts,
    step: { kind: "idle" },
  });
  const step: Step = state.artifacts === artifacts ? state.step : { kind: "idle" };
  const setStep = (next: Step) => setState({ artifacts, step: next });

  const compare = async () => {
    setStep({ kind: "checking" });
    const match = await findPublishedLesson({ title });
    if ("refused" in match) {
      setStep({ kind: "refused", message: match.refused });
      return;
    }
    const result = await replacePublishedLesson({
      lessonId: match.found.lessonId,
      run: { title, artifacts },
      replace: false,
    });
    if ("compared" in result) {
      setStep({ kind: "compared", lesson: match.found, change: result.compared });
    } else if ("refused" in result) {
      setStep({ kind: "refused", message: result.refused });
    }
  };

  const replace = async (lesson: FoundLesson) => {
    setStep({ kind: "replacing", lesson, fraction: null });
    const result = await replacePublishedLesson({
      lessonId: lesson.lessonId,
      run: { title, artifacts },
      replace: true,
      onProgress: (fraction) => setStep({ kind: "replacing", lesson, fraction }),
      queryClient,
    });
    if ("replaced" in result) {
      setStep({
        kind: "replaced",
        lesson,
        change: result.replaced,
        audioFile: result.replaced.audioFile,
        removedAudioFile: result.replaced.removedAudioFile,
      });
    } else if ("refused" in result) {
      setStep({ kind: "refused", message: result.refused });
    }
  };

  const busy = step.kind === "checking" || step.kind === "replacing";

  // `contents`: the button is one more item in the results panel's row of
  // buttons (Render again, Download bundle…), aligned with them; what it opens
  // takes a row of its own under it.
  return (
    <div className="contents">
      <button
        type="button"
        onClick={() => void compare()}
        disabled={busy}
        className={QUIET_BUTTON}
        title="Find the lesson this run was published as and show what replacing it would change. Nothing is replaced until you confirm."
      >
        <Replace aria-hidden="true" className="size-3.5" />
        Replace published lesson…
      </button>

      {step.kind === "checking" ? (
        <p role="status" className="basis-full text-[12px] text-slate-400">
          Finding the published lesson…
        </p>
      ) : null}

      {step.kind === "compared" ? (
        <div className="basis-full rounded-lg border border-slate-600/40 p-2">
          <LessonChangeSummary lesson={step.lesson} change={step.change} />
          <p className="mt-1 text-[12px] text-slate-400">
            The lesson keeps its URL, thumbnail, playlist place and publish date.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void replace(step.lesson)}
              className={CONFIRM_BUTTON}
            >
              Replace “{step.lesson.title}”
            </button>
            <button
              type="button"
              onClick={() => setStep({ kind: "idle" })}
              className={QUIET_BUTTON}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {step.kind === "replacing" ? (
        <p role="status" className="basis-full text-[12px] text-slate-400">
          Replacing “{step.lesson.title}”…
          {step.fraction === null ? "" : ` ${Math.round(step.fraction * 100)}%`}
        </p>
      ) : null}

      {step.kind === "replaced" ? (
        <div role="status" className="basis-full rounded-lg border border-emerald-500/30 p-2">
          <p className="text-[12px] font-semibold text-emerald-300">Replaced.</p>
          <LessonChangeSummary lesson={step.lesson} change={step.change} />
          <p className="mt-1 text-[12px] text-slate-400">
            Narration: <span className="font-mono">{step.audioFile}</span>
            {step.removedAudioFile ? (
              <>
                ; removed <span className="font-mono">{step.removedAudioFile}</span>
              </>
            ) : (
              "; no old narration file was removed"
            )}
            .
          </p>
        </div>
      ) : null}

      {step.kind === "refused" ? (
        <p
          role="alert"
          className="basis-full rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-[12px] text-rose-200"
        >
          {step.message}
        </p>
      ) : null}
    </div>
  );
}
