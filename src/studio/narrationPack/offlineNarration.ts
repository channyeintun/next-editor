import { createStore } from "@xstate/store-react";
import { downloadBlob } from "../../utils/downloadBlob";
import type { NarrationAudioImport } from "./audioImport";
import type { LessonNarrationCoverage, NarrationCoverage } from "./coverage";
import type { NarrationRequestPackExport } from "./requestPack";

/**
 * The state of an offline narration export or import, kept outside the
 * component that starts it. An import of a course's audio runs for minutes:
 * its progress and its result must outlive the Workflow tab's setup view, and
 * the console must be able to hold renders back until it has finished — a
 * render started early finds takes missing and buys them from the hosted
 * voice, which is the cost the import exists to avoid.
 */

export interface OfflineNarrationApi {
  /** Why the console cannot export requests now (the voice, the narrator reference), or null. */
  exportBlockedReason: string | null;
  /** The requests of these lessons that this browser has no take for. Rejects with the reason. */
  exportRequests: (slugs: readonly string[]) => Promise<NarrationRequestPackExport>;
  importAudio: (
    files: readonly File[],
    onProgress: (takes: number) => void,
  ) => Promise<NarrationAudioImport>;
  /** How much of these lessons' narration this browser keeps. Rejects with the reason. */
  coverageOf: (slugs: readonly string[], signal: AbortSignal) => Promise<NarrationCoverage>;
}

export interface OfflineNarrationStatus {
  tone: "ok" | "warning" | "error";
  text: string;
  /** The lesson selection an export's result is about; an import's is about none. */
  forSlugs?: string;
}

interface OfflineNarrationContext {
  busy: "export" | "import" | null;
  /** Takes the running import has filed or found kept. */
  importedTakes: number;
  /** Imports that have ended: what this browser keeps may have changed with each. */
  importsEnded: number;
  status: OfflineNarrationStatus | null;
}

const INITIAL_CONTEXT: OfflineNarrationContext = {
  busy: null,
  importedTakes: 0,
  importsEnded: 0,
  status: null,
};

export const offlineNarrationStore = createStore({
  context: INITIAL_CONTEXT,
  on: {
    started: (
      context,
      event: { kind: "export" | "import"; status: OfflineNarrationStatus },
    ): OfflineNarrationContext => ({
      ...context,
      busy: event.kind,
      importedTakes: 0,
      status: event.status,
    }),
    progressed: (context, event: { takes: number }): OfflineNarrationContext => ({
      ...context,
      importedTakes: event.takes,
    }),
    finished: (context, event: { status: OfflineNarrationStatus }): OfflineNarrationContext => ({
      ...context,
      busy: null,
      importsEnded: context.importsEnded + (context.busy === "import" ? 1 : 0),
      status: event.status,
    }),
    reset: (): OfflineNarrationContext => INITIAL_CONTEXT,
  },
});

/** While an import files takes, a render would buy the ones it has not reached yet. */
export const selectNarrationImportRunning = (context: OfflineNarrationContext): boolean =>
  context.busy === "import";

/** The key a status is tied to a lesson selection by. */
export const selectionKeyOf = (slugs: readonly string[]): string => slugs.join("\n");

const count = (value: number) => value.toLocaleString("en-US");
const plural = (value: number, one: string, many = `${one}s`) =>
  `${count(value)} ${value === 1 ? one : many}`;
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Lessons a coverage report names before it counts the rest. */
const COVERAGE_LESSONS_NAMED = 3;

export function exportStatusOf(exported: NarrationRequestPackExport): OfflineNarrationStatus {
  if (!exported.pack) {
    return {
      tone: "ok",
      text:
        exported.cachedCount > 0
          ? `Nothing to export: this browser already keeps all ${plural(exported.cachedCount, "dialog")} of these lessons.`
          : "Nothing to export: these lessons have no narration.",
    };
  }
  if (exported.cacheUnavailable) {
    return {
      tone: "warning",
      text: `Exported ${plural(exported.dialogCount, "dialog")}, but this browser cannot keep narration (${exported.cacheUnavailable}), so it will not be able to import the audio.`,
    };
  }
  const kept =
    exported.cachedCount > 0
      ? ` ${plural(exported.cachedCount, "dialog")} already in this browser ${exported.cachedCount === 1 ? "was" : "were"} left out.`
      : "";
  return {
    tone: "ok",
    text: `Exported ${plural(exported.dialogCount, "dialog")} of ${plural(exported.lessonCount, "lesson")} (${count(exported.characterCount)} characters).${kept}`,
  };
}

export function importStatusOf(imported: NarrationAudioImport): OfflineNarrationStatus {
  const takes = imported.imported + imported.alreadyCached;
  if (takes === 0 && imported.unusable.length === 0 && !imported.storageFailure) {
    return { tone: "warning", text: "No narration takes were found in those files." };
  }
  const parts = [`Imported ${plural(imported.imported, "take")}.`];
  if (imported.alreadyCached > 0) {
    parts.push(
      `${plural(imported.alreadyCached, "take")} ${imported.alreadyCached === 1 ? "was" : "were"} already in this browser.`,
    );
  }
  if (imported.unusable.length > 0) {
    const first = imported.unusable[0];
    parts.push(
      `${plural(imported.unusable.length, "file")} could not be used (${first.name}: ${first.reason}).`,
    );
  }
  if (imported.storageFailure) {
    parts.push(
      `The browser keeps no more narration (${imported.storageFailure}); the rest was not imported.`,
    );
  }
  return {
    tone: imported.storageFailure ? "error" : imported.unusable.length > 0 ? "warning" : "ok",
    text: parts.join(" "),
  };
}

/** What the picked lessons' coverage means for a render, in words. */
export interface NarrationCoverageReport {
  status: OfflineNarrationStatus;
  /** The lessons with all their narration here, when only some of the picked ones have it. */
  completeOnly: string[] | null;
}

/**
 * Whether a render of these lessons would ask the speech service for anything.
 * Audio is imported in parts of a few dozen dialogs, so this, and not the
 * number of files imported, is what says which lessons are ready.
 */
export function coverageReportOf(coverage: NarrationCoverage): NarrationCoverageReport | null {
  const total = coverage.lessons.length;
  if (total === 0) return null;
  if (coverage.cacheUnavailable) {
    return {
      status: {
        tone: "warning",
        text: `This browser cannot keep narration (${coverage.cacheUnavailable}): a render asks the speech service for every dialog of the picked lessons.`,
      },
      completeOnly: null,
    };
  }
  const complete = coverage.lessons.filter((lesson) => lesson.missingCount === 0);
  const incomplete = coverage.lessons.filter((lesson) => lesson.missingCount > 0);
  if (incomplete.length === 0) {
    return {
      status: {
        tone: "ok",
        text:
          total === 1
            ? "The picked lesson has all its narration in this browser: a render asks no speech service for it."
            : `All ${count(total)} picked lessons have their narration in this browser: a render asks no speech service for it.`,
      },
      completeOnly: null,
    };
  }
  const missing = `${plural(coverage.missingDialogCount, "dialog")} (${count(coverage.missingCharacterCount)} characters)`;
  if (
    incomplete.every((lesson) => lesson.missingCount === lesson.dialogCount) &&
    complete.length === 0
  ) {
    return {
      status: {
        tone: "ok",
        text: `None of the narration of the ${total === 1 ? "picked lesson" : `${count(total)} picked lessons`} is in this browser yet: a render asks the speech service for all of it, ${missing}.`,
      },
      completeOnly: null,
    };
  }
  if (total === 1) {
    const [lesson] = incomplete;
    return {
      status: {
        tone: "warning",
        text: `The picked lesson lacks ${count(lesson.missingCount)} of its ${plural(lesson.dialogCount, "dialog")} in this browser: a render asks the speech service for ${lesson.missingCount === 1 ? "it" : "those"} (${count(coverage.missingCharacterCount)} characters).`,
      },
      completeOnly: null,
    };
  }
  const named = incomplete
    .slice(0, COVERAGE_LESSONS_NAMED)
    .map((lesson) => `${lesson.slug} ${lackOf(lesson)}`)
    .join(", ");
  const more =
    incomplete.length > COVERAGE_LESSONS_NAMED
      ? `, and ${plural(incomplete.length - COVERAGE_LESSONS_NAMED, "more lesson")}`
      : "";
  const one = complete.length === 1;
  const whole =
    complete.length === 0
      ? `None of the ${count(total)} picked lessons have all their narration in this browser. They lack`
      : `${count(complete.length)} of the ${count(total)} picked lessons ${one ? "has" : "have"} all ${one ? "its" : "their"} narration in this browser. ${incomplete.length === 1 ? "The other one lacks" : `The other ${count(incomplete.length)} lack`}`;
  return {
    status: {
      tone: "warning",
      text: `${whole} ${missing}, which a render asks the speech service for: ${named}${more}.`,
    },
    completeOnly: complete.length > 0 ? complete.map((lesson) => lesson.slug) : null,
  };
}

/** What one lesson is missing, after its name: "lacks 2 of its 39 dialogs". */
function lackOf(lesson: LessonNarrationCoverage): string {
  if (lesson.missingCount < lesson.dialogCount) {
    return `lacks ${count(lesson.missingCount)} of its ${plural(lesson.dialogCount, "dialog")}`;
  }
  return lesson.dialogCount === 1
    ? "lacks its one dialog"
    : `lacks all ${count(lesson.dialogCount)} of its dialogs`;
}

/** Export these lessons' requests and download the pack. One export or import runs at a time. */
export async function exportNarrationRequests(
  api: OfflineNarrationApi,
  slugs: readonly string[],
): Promise<void> {
  if (offlineNarrationStore.getSnapshot().context.busy !== null) return;
  const forSlugs = selectionKeyOf(slugs);
  offlineNarrationStore.trigger.started({
    kind: "export",
    status: { tone: "ok", text: "Exporting the requests…", forSlugs },
  });
  let status: OfflineNarrationStatus;
  try {
    const exported = await api.exportRequests(slugs);
    if (exported.pack) {
      downloadBlob(
        new Blob([JSON.stringify(exported.pack)], { type: "application/json" }),
        `narration-requests-${exported.pack.createdAt.slice(0, 10)}.json`,
      );
    }
    status = { ...exportStatusOf(exported), forSlugs };
  } catch (error) {
    status = { tone: "error", text: reasonOf(error), forSlugs };
  }
  offlineNarrationStore.trigger.finished({ status });
}

/** File the takes in these files into the dialog cache, reporting progress as it goes. */
export async function importNarrationFiles(
  api: OfflineNarrationApi,
  files: readonly File[],
): Promise<void> {
  if (files.length === 0 || offlineNarrationStore.getSnapshot().context.busy !== null) return;
  offlineNarrationStore.trigger.started({
    kind: "import",
    status: { tone: "ok", text: "Importing the audio…" },
  });
  let status: OfflineNarrationStatus;
  try {
    status = importStatusOf(
      await api.importAudio(files, (takes) => offlineNarrationStore.trigger.progressed({ takes })),
    );
  } catch (error) {
    status = { tone: "error", text: reasonOf(error) };
  }
  offlineNarrationStore.trigger.finished({ status });
}
