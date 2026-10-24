import {
  addLessonsToPlaylist,
  MAX_DESCRIPTION_CHARS,
  MAX_TITLE_CHARS,
  prepareThumbnail,
  publishLesson,
  uploadLesson,
  type UploadLessonInput,
} from "@next-editor/infra";
import type { Recording } from "../../core/src";
import { describeDraftDescription } from "../draftProvenance";
import type { WorkflowDraft } from "./workflowQueue";

/**
 * The workflow's draft and publish steps: what "Create draft…" and the
 * modal's Publish button do, with the fields the modal would have pre-filled
 * (the run's title, the public-safe description, the studio tags) and the
 * lesson's matched thumbnail instead of a hand-picked one.
 */

/** The tags the studio's draft upload pre-fills. */
const STUDIO_DRAFT_TAGS = ["studio", "ai-produced"];

export interface WorkflowUploadInput {
  /** Reused across retries: a retry writes over the same storage keys. */
  uploadId: string;
  title: string;
  recording: Recording;
  /** The matched thumbnail; null uses the site default when `useDefault`, else none. */
  thumbnail: File | null;
  useDefaultThumbnail: boolean;
  onProgress: (progress: number) => void;
}

export async function uploadWorkflowDraft(input: WorkflowUploadInput): Promise<WorkflowDraft> {
  const title = input.title.trim();
  const description = describeDraftDescription({ title });
  // The Worker refuses these, but only after every byte went up.
  if (!title) throw new Error("The lesson has no title");
  if (title.length > MAX_TITLE_CHARS) {
    throw new Error(`The title is ${title.length} characters, over the ${MAX_TITLE_CHARS} limit`);
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw new Error(
      `The description is ${description.length} characters, over the ${MAX_DESCRIPTION_CHARS} limit`,
    );
  }

  let thumbnail: File | undefined;
  if (input.thumbnail) {
    const prepared = await prepareThumbnail(input.thumbnail);
    if ("error" in prepared) {
      throw new Error(`Thumbnail ${input.thumbnail.name}: ${prepared.error}`);
    }
    thumbnail = prepared.file;
  }

  const lesson: UploadLessonInput = {
    recording: input.recording,
    title,
    description,
    tags: STUDIO_DRAFT_TAGS,
    thumbnail,
    useDefaultThumbnail: !thumbnail && input.useDefaultThumbnail,
  };
  const uploaded = await uploadLesson(input.uploadId, lesson, input.onProgress);
  return { lessonId: uploaded.id, urlSlug: uploaded.slug };
}

export async function publishWorkflowDraft(draft: WorkflowDraft): Promise<void> {
  await publishLesson(draft.lessonId);
}

/** Append a published lesson to the workflow's playlist; one already there is fine. */
export async function addWorkflowLessonToPlaylist(
  playlistId: string,
  lessonId: string,
): Promise<void> {
  const { notEligible } = await addLessonsToPlaylist(playlistId, [lessonId]);
  if (notEligible.includes(lessonId)) {
    throw new Error(
      "The playlist refused the lesson: it is not one of your published lessons (was it unpublished?)",
    );
  }
}
