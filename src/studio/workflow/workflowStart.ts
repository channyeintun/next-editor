import { THUMBNAIL_ACCEPT } from "@next-editor/infra";
import { matchThumbnail, orderWorkflowLessons } from "./workflowLessons";
import type { WorkflowLessonInput, WorkflowSettings } from "./workflowQueue";
import type { NewWorkflowInput } from "./workflowRunner";

/**
 * Every rule a new studio workflow must pass before it starts, in one pure
 * function: the Start workflow button and the automation surface both ask it,
 * so a workflow started without a click is held to exactly what a click is.
 */

const ACCEPTED_THUMBNAIL_TYPES: ReadonlySet<string> = new Set(THUMBNAIL_ACCEPT.split(","));

/** The images among `files` that a lesson thumbnail may be, by their type. */
export function acceptedThumbnails(files: Iterable<File>): File[] {
  return [...files].filter((file) => ACCEPTED_THUMBNAIL_TYPES.has(file.type));
}

/** What the workflow knows about one lesson: its title, or why it cannot take it. */
export type WorkflowLessonInfo = { title: string } | { error: string };

export interface WorkflowStartRequest {
  /** The lessons asked for, in any order. */
  slugs: Iterable<string>;
  settings: WorkflowSettings;
  /** The picked images; matched to lessons by file name. */
  thumbnails: Iterable<File>;
  /** The lesson's title from the lesson list, or why the workflow cannot take it. */
  lessonOf: (slug: string) => WorkflowLessonInfo;
  /** Why the studio cannot start a new workflow now (busy, narration not set up), or null. */
  blockedReason: string | null;
}

export interface WorkflowStartPlan {
  /** The lessons in the order the workflow takes them, each with its matched image's name. */
  queue: { slug: string; thumbnail: string | null }[];
  /** The lessons no picked image matches, when the workflow creates drafts. */
  missingThumbnails: string[];
  /** What to start, or the reason it cannot start, in words for the person who asked. */
  outcome: { start: NewWorkflowInput } | { refused: string };
}

export function planWorkflowStart(request: WorkflowStartRequest): WorkflowStartPlan {
  const images = new Map(acceptedThumbnails(request.thumbnails).map((file) => [file.name, file]));
  const names = [...images.keys()];
  // Course order also decides the order lessons join a playlist in.
  const queue = orderWorkflowLessons(
    [...new Set(request.slugs)].map((slug) => ({ slug, thumbnail: matchThumbnail(slug, names) })),
  );
  const missingThumbnails = request.settings.createDraft
    ? queue.filter((lesson) => !lesson.thumbnail).map((lesson) => lesson.slug)
    : [];
  const refused = (reason: string): WorkflowStartPlan => ({
    queue,
    missingThumbnails,
    outcome: { refused: reason },
  });

  if (request.blockedReason !== null) return refused(request.blockedReason);
  if (queue.length === 0) return refused("Pick at least one lesson.");
  if (missingThumbnails.length > 0 && !request.settings.defaultThumbnailWhenMissing) {
    const named = `${missingThumbnails.slice(0, 3).join(", ")}${missingThumbnails.length > 3 ? ", …" : ""}`;
    return refused(
      `${missingThumbnails.length} of ${queue.length} lessons have no thumbnail in the picked folder (${named}). Pick the course's thumbnail folder, or allow the default thumbnail.`,
    );
  }

  // A lesson the workflow cannot narrate fails before the workflow starts,
  // not hours in.
  const lessons: WorkflowLessonInput[] = [];
  const thumbnails = new Map<string, File>();
  for (const lesson of queue) {
    const info = request.lessonOf(lesson.slug);
    if ("error" in info) return refused(`${lesson.slug}: ${info.error}`);
    lessons.push({ ...lesson, title: info.title });
    const image = lesson.thumbnail ? images.get(lesson.thumbnail) : undefined;
    if (image) thumbnails.set(lesson.slug, image);
  }
  return {
    queue,
    missingThumbnails,
    outcome: { start: { lessons, settings: request.settings, thumbnails } },
  };
}
