import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleX,
  Image,
  ImageOff,
  LoaderCircle,
} from "lucide-react";
import { THUMBNAIL_ACCEPT } from "@next-editor/infra";
import HoverRing from "../../components/hoverRing/HoverRing";
import { copyTextToClipboard } from "../../utils/clipboard";
import { downloadBlob } from "../../utils/downloadBlob";
import type { StudioWorkflowApi } from "./useStudioWorkflow";
import { groupLessons, matchThumbnail, orderWorkflowLessons } from "./workflowLessons";
import {
  workflowIssueOf,
  workflowProgressOf,
  type StudioWorkflow,
  type WorkflowLesson,
  type WorkflowSettings,
  type WorkflowState,
} from "./workflowQueue";

/**
 * The studio console's Workflow tab: pick lessons (whole courses at once),
 * point it at the course's thumbnail folder, choose how far each lesson goes
 * (render, draft, publish), and start. The studio then takes the lessons
 * through those steps one after another and stops at the first failure with
 * an issue report to hand to Claude; Resume picks up at that lesson.
 */

interface StudioWorkflowPanelProps {
  api: StudioWorkflowApi;
  slugs: readonly string[];
  /**
   * A lesson's title from its script, or why the workflow cannot take it (the
   * script does not parse, or the chosen narration cannot speak its language).
   */
  lessonOf: (slug: string) => { title: string } | { error: string };
  /** Why no workflow can start or resume now (narration not ready, a render running), or null. */
  blockedReason: string | null;
  /** The render phase of the lesson rendering now. */
  phase: string;
}

const PRIMARY_BUTTON =
  "rounded-md bg-[#173925] px-3 py-1.5 font-bold uppercase tracking-[0.04em] text-[#58d88d] transition-colors hover:bg-[#1f4a31] disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON =
  "rounded-md bg-[#222d3b] px-3 py-1.5 font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] disabled:cursor-not-allowed disabled:opacity-50";
const DANGER_BUTTON =
  "rounded-md bg-[#3b2a22] px-3 py-1.5 font-bold uppercase tracking-[0.04em] text-[#efb28d] transition-colors hover:bg-[#4d382a] disabled:cursor-not-allowed disabled:opacity-50";

const ACCEPTED_THUMBNAIL_TYPES = new Set(THUMBNAIL_ACCEPT.split(","));

const STATE_LABELS: Record<WorkflowState, string> = {
  ready: "ready",
  running: "running",
  stopping: "stopping",
  stopped: "stopped",
  failed: "stopped at an issue",
  finished: "finished",
};

export default function StudioWorkflowPanel(props: StudioWorkflowPanelProps) {
  const { api } = props;
  const [settingUp, setSettingUp] = useState(api.workflow === null);

  if (settingUp || !api.workflow) {
    return (
      <WorkflowSetup
        {...props}
        onCancel={api.workflow ? () => setSettingUp(false) : null}
        onStarted={() => setSettingUp(false)}
      />
    );
  }
  return (
    <WorkflowRun
      api={api}
      workflow={api.workflow}
      blockedReason={props.blockedReason}
      phase={props.phase}
      onNewWorkflow={() => setSettingUp(true)}
    />
  );
}

function WorkflowSetup({
  api,
  slugs,
  lessonOf,
  blockedReason,
  onCancel,
  onStarted,
}: StudioWorkflowPanelProps & { onCancel: (() => void) | null; onStarted: () => void }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [settings, setSettings] = useState<WorkflowSettings>({
    createDraft: true,
    publish: true,
    defaultThumbnailWhenMissing: false,
  });
  const [thumbnails, setThumbnails] = useState<{ folder: string; files: Map<string, File> }>({
    folder: "",
    files: new Map(),
  });
  const [startError, setStartError] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // React has no prop for a folder picker; Chrome reads the attribute.
  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
  }, []);

  const query = filter.trim().toLowerCase();
  const groups = groupLessons(query ? slugs.filter((slug) => slug.includes(query)) : slugs);
  const thumbnailNames = [...thumbnails.files.keys()];
  const thumbnailOf = (slug: string) => matchThumbnail(slug, thumbnailNames);
  const queue = orderWorkflowLessons(
    [...selected].map((slug) => ({ slug, thumbnail: thumbnailOf(slug) })),
  );
  const missingThumbnails = settings.createDraft
    ? queue.filter((lesson) => !lesson.thumbnail).map((lesson) => lesson.slug)
    : [];

  const startBlockedReason =
    blockedReason ??
    (queue.length === 0
      ? "Pick at least one lesson."
      : missingThumbnails.length > 0 && !settings.defaultThumbnailWhenMissing
        ? `${missingThumbnails.length} of ${queue.length} lessons have no thumbnail in the picked folder (${missingThumbnails.slice(0, 3).join(", ")}${missingThumbnails.length > 3 ? ", …" : ""}). Pick the course's thumbnail folder, or allow the default thumbnail.`
        : null);

  const toggleLessons = (members: readonly string[], on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const slug of members) {
        if (on) next.add(slug);
        else next.delete(slug);
      }
      return next;
    });
  };

  const toggleExpanded = (name: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const pickFolder = (files: FileList | null) => {
    const picked = new Map<string, File>();
    let folder = "";
    for (const file of Array.from(files ?? [])) {
      if (!ACCEPTED_THUMBNAIL_TYPES.has(file.type)) continue;
      picked.set(file.name, file);
      if (!folder) folder = file.webkitRelativePath.split("/")[0] ?? "";
    }
    setThumbnails({ folder, files: picked });
  };

  const startWorkflow = () => {
    setStartError(null);
    const lessons = [];
    for (const lesson of queue) {
      const info = lessonOf(lesson.slug);
      if ("error" in info) {
        setStartError(`${lesson.slug}: ${info.error}`);
        return;
      }
      lessons.push({ ...lesson, title: info.title });
    }
    const byLesson = new Map<string, File>();
    for (const lesson of lessons) {
      const file = lesson.thumbnail ? thumbnails.files.get(lesson.thumbnail) : undefined;
      if (file) byLesson.set(lesson.slug, file);
    }
    onStarted();
    void api.start({ lessons, settings, thumbnails: byLesson });
  };

  return (
    <div className="mt-2 space-y-3">
      <div>
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold text-slate-100">Lessons</h3>
          <span className="text-[12px] text-slate-400">{selected.size} selected</span>
        </div>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter lessons"
          aria-label="Filter lessons"
          className="mt-1.5 w-full rounded-md border border-slate-500 bg-[#151a22] px-2 py-1.5 font-mono text-[12px] text-slate-200 placeholder:text-slate-500"
        />
        <ul className="mt-1.5 max-h-64 overflow-y-auto rounded-md border border-slate-700">
          {groups.map((group) => {
            const count = group.slugs.filter((slug) => selected.has(slug)).length;
            const open = expanded.has(group.name) || query !== "";
            return (
              <li key={group.name} className="border-b border-slate-800 last:border-b-0">
                <div className="flex items-center gap-2 px-2 py-1">
                  <input
                    type="checkbox"
                    checked={count === group.slugs.length}
                    ref={(input) => {
                      if (input) input.indeterminate = count > 0 && count < group.slugs.length;
                    }}
                    onChange={(event) => toggleLessons(group.slugs, event.target.checked)}
                    aria-label={`All ${group.name} lessons`}
                    className="size-3.5 accent-sky-500"
                  />
                  <button
                    type="button"
                    onClick={() => toggleExpanded(group.name)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left text-slate-200 hover:text-white"
                  >
                    {open ? (
                      <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
                    ) : (
                      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate font-mono text-[12px]">{group.name}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-slate-400">
                      {count}/{group.slugs.length}
                    </span>
                  </button>
                </div>
                {open ? (
                  <ul className="pb-1">
                    {group.slugs.map((slug) => {
                      const thumbnail = thumbnailOf(slug);
                      return (
                        <li key={slug}>
                          <label className="flex items-center gap-2 py-0.5 pl-7 pr-2 text-[12px] text-slate-300 hover:bg-[#151a22]">
                            <input
                              type="checkbox"
                              checked={selected.has(slug)}
                              onChange={(event) => toggleLessons([slug], event.target.checked)}
                              className="size-3.5 accent-sky-500"
                            />
                            <span className="min-w-0 flex-1 truncate font-mono">{slug}</span>
                            {thumbnails.files.size > 0 ? (
                              thumbnail ? (
                                <Image
                                  aria-label={`Thumbnail ${thumbnail}`}
                                  className="size-3.5 shrink-0 text-emerald-400"
                                />
                              ) : (
                                <ImageOff
                                  aria-label="No thumbnail matches"
                                  className="size-3.5 shrink-0 text-amber-400"
                                />
                              )
                            ) : null}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <h3 className="font-semibold text-slate-100">Thumbnails</h3>
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => folderInputRef.current?.click()}
            className={`shrink-0 ${SECONDARY_BUTTON}`}
          >
            Choose folder…
            <HoverRing />
          </button>
          <span className="min-w-0 truncate text-[12px] text-slate-400">
            {thumbnails.files.size > 0
              ? `${thumbnails.folder || "folder"}: ${thumbnails.files.size} images${
                  queue.length > 0
                    ? ` · ${queue.length - queue.filter((lesson) => !lesson.thumbnail).length}/${queue.length} lessons matched`
                    : ""
                }`
              : "Matched to lessons by file name, like 01-basics.png"}
          </span>
          <input
            ref={folderInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              pickFolder(event.target.files);
              event.target.value = "";
            }}
          />
        </div>
      </div>

      <fieldset>
        <legend className="font-semibold text-slate-100">Each lesson</legend>
        <p className="mt-1 text-[12px] text-slate-400">
          Renders with the narration chosen in the Render tab.
        </p>
        <label className="mt-1.5 flex items-center gap-2 text-[12px] text-slate-300">
          <input
            type="checkbox"
            checked={settings.createDraft || settings.publish}
            disabled={settings.publish}
            onChange={(event) =>
              setSettings((current) => ({ ...current, createDraft: event.target.checked }))
            }
            className="size-3.5 accent-sky-500 disabled:opacity-50"
          />
          Create a draft
        </label>
        <label className="mt-1 flex items-center gap-2 text-[12px] text-slate-300">
          <input
            type="checkbox"
            checked={settings.publish}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                publish: event.target.checked,
                createDraft: current.createDraft || event.target.checked,
              }))
            }
            className="size-3.5 accent-sky-500"
          />
          Publish the draft
        </label>
        <label className="mt-1 flex items-center gap-2 text-[12px] text-slate-300">
          <input
            type="checkbox"
            checked={settings.defaultThumbnailWhenMissing}
            disabled={!settings.createDraft}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                defaultThumbnailWhenMissing: event.target.checked,
              }))
            }
            className="size-3.5 accent-sky-500 disabled:opacity-50"
          />
          Use the default thumbnail when none matches
        </label>
      </fieldset>

      {api.setupError || startError ? (
        <p
          role="alert"
          className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-rose-200"
        >
          {startError ?? api.setupError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={startWorkflow}
          disabled={startBlockedReason !== null}
          aria-describedby={startBlockedReason ? "studio-workflow-blocked-reason" : undefined}
          className={PRIMARY_BUTTON}
        >
          Start workflow
          {queue.length > 0 ? ` (${queue.length})` : ""}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel} className={SECONDARY_BUTTON}>
            Back to the current workflow
          </button>
        ) : null}
      </div>
      {onCancel ? (
        <p className="text-[12px] text-slate-400">
          Starting replaces the current workflow and its progress.
        </p>
      ) : null}
      {startBlockedReason ? (
        <p id="studio-workflow-blocked-reason" className="text-[12px] text-amber-300">
          {startBlockedReason}
        </p>
      ) : null}
    </div>
  );
}

function WorkflowRun({
  api,
  workflow,
  blockedReason,
  phase,
  onNewWorkflow,
}: {
  api: StudioWorkflowApi;
  workflow: StudioWorkflow;
  blockedReason: string | null;
  phase: string;
  onNewWorkflow: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { done, total } = workflowProgressOf(workflow);
  const stoppedAt = workflowIssueOf(workflow);
  const canResume =
    !api.active && workflow.state !== "finished" && done < total && blockedReason === null;
  const steps = workflow.settings.publish
    ? "render → draft → publish"
    : workflow.settings.createDraft
      ? "render → draft"
      : "render only";

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyIssue = async () => {
    if (stoppedAt && (await copyTextToClipboard(stoppedAt.issue.report))) setCopied(true);
  };

  return (
    <div className="mt-2 space-y-3">
      <div>
        <div className="flex items-center justify-between gap-2 text-[12px]">
          <span className="text-slate-300">
            {steps} · {STATE_LABELS[workflow.state]}
          </span>
          <span className="font-mono text-slate-200" aria-live="polite">
            {done}/{total} done
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Workflow progress"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-800"
        >
          <div
            className={`h-full rounded-full ${workflow.state === "failed" ? "bg-rose-400" : "bg-emerald-400"}`}
            style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
          />
        </div>
      </div>

      {stoppedAt ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-[12px] text-rose-200">
          <p className="font-semibold">
            Stopped at <span className="font-mono">{stoppedAt.lesson.slug}</span> (
            {stoppedAt.issue.step}
            {stoppedAt.issue.phase ? ` · ${stoppedAt.issue.phase}` : ""})
          </p>
          <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words">
            {stoppedAt.issue.message}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => void copyIssue()} className={SECONDARY_BUTTON}>
              {copied ? "Copied" : "Copy issue for Claude"}
            </button>
            <button
              type="button"
              onClick={() =>
                downloadBlob(
                  new Blob([stoppedAt.issue.report], { type: "text/markdown" }),
                  `studio-workflow-issue-${stoppedAt.lesson.slug}.md`,
                )
              }
              className={SECONDARY_BUTTON}
            >
              Download issue
            </button>
            {api.failedReport ? (
              <button
                type="button"
                onClick={() =>
                  downloadBlob(
                    new Blob([JSON.stringify(api.failedReport, null, 2)], {
                      type: "application/json",
                    }),
                    `render-report-${stoppedAt.lesson.slug}.json`,
                  )
                }
                className={SECONDARY_BUTTON}
              >
                Render report
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {api.active ? (
          <button
            type="button"
            onClick={api.requestStop}
            disabled={workflow.state === "stopping"}
            className={DANGER_BUTTON}
          >
            {workflow.state === "stopping"
              ? "Stopping after this lesson…"
              : "Stop after this lesson"}
          </button>
        ) : (
          <>
            {workflow.state !== "finished" && done < total ? (
              <button
                type="button"
                onClick={() => void api.start()}
                disabled={!canResume}
                className={PRIMARY_BUTTON}
              >
                {workflow.state === "ready" ? "Start" : "Resume"}
              </button>
            ) : null}
            {/* Nothing is lost until the new workflow starts: setup can go back. */}
            <button type="button" onClick={onNewWorkflow} className={SECONDARY_BUTTON}>
              New workflow
            </button>
          </>
        )}
      </div>
      {!api.active && blockedReason && workflow.state !== "finished" ? (
        <p className="text-[12px] text-amber-300">{blockedReason}</p>
      ) : null}

      <ol className="max-h-72 overflow-y-auto rounded-md border border-slate-700">
        {workflow.lessons.map((lesson) => (
          <WorkflowLessonRow
            key={lesson.slug}
            lesson={lesson}
            active={lesson.slug === api.activeSlug}
            phase={phase}
            uploadProgress={api.uploadProgress}
            publishes={workflow.settings.publish}
          />
        ))}
      </ol>
    </div>
  );
}

function WorkflowLessonRow({
  lesson,
  active,
  phase,
  uploadProgress,
  publishes,
}: {
  lesson: WorkflowLesson;
  active: boolean;
  phase: string;
  uploadProgress: number | null;
  publishes: boolean;
}) {
  let detail: ReactNode;
  switch (lesson.status) {
    case "rendering":
      detail = active ? phase : "rendering";
      break;
    case "uploading":
      detail = `uploading${active && uploadProgress !== null ? ` ${Math.round(uploadProgress * 100)}%` : ""}`;
      break;
    case "publishing":
      detail = "publishing";
      break;
    case "failed":
      detail = `failed at ${lesson.issue?.step ?? "a step"}`;
      break;
    case "done":
      detail =
        lesson.published && lesson.draft ? (
          <a
            href={`/learn/${lesson.draft.urlSlug}`}
            target="_blank"
            rel="noreferrer"
            className="text-emerald-300 underline-offset-2 hover:underline"
          >
            published
          </a>
        ) : lesson.draft ? (
          "draft created"
        ) : (
          "rendered"
        );
      break;
    default:
      detail = lesson.draft && publishes ? "draft ready, publish next" : "queued";
  }

  const icon =
    lesson.status === "done" ? (
      <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-emerald-400" />
    ) : lesson.status === "failed" ? (
      <CircleX aria-hidden="true" className="size-3.5 shrink-0 text-rose-400" />
    ) : lesson.status === "queued" ? (
      <Circle aria-hidden="true" className="size-3.5 shrink-0 text-slate-500" />
    ) : (
      <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-amber-300" />
    );

  return (
    <li
      aria-current={active ? "step" : undefined}
      className={`flex items-center gap-2 border-b border-slate-800 px-2 py-1 text-[12px] last:border-b-0 ${
        active ? "bg-[#151a22]" : ""
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate font-mono text-slate-200" title={lesson.title}>
        {lesson.slug}
      </span>
      <span className="shrink-0 text-slate-400">{detail}</span>
    </li>
  );
}
