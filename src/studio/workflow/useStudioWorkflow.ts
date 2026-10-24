import { useEffect, useLayoutEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateLessonDerivedQueries } from "@next-editor/infra";
import { acquireDisplayStream } from "../../utils/displayCapture";
import type { StudioRenderReport } from "../report";
import { isWorkflowActive, restoreWorkflow, type StudioWorkflow } from "./workflowQueue";
import { createWorkflowRunner, type StudioWorkflowDeps } from "./workflowRunner";
import {
  clearWorkflowThumbnails,
  loadStoredWorkflow,
  loadWorkflowThumbnail,
  storeWorkflow,
  storeWorkflowThumbnails,
} from "./workflowStorage";
import {
  addWorkflowLessonToPlaylist,
  publishWorkflowDraft,
  uploadWorkflowDraft,
} from "./workflowUpload";

/** The workflow as `window.__NEXT_EDITOR_STUDIO__` carries it, for automation and Claude. */
function publishWorkflowHandle(workflow: StudioWorkflow | null): void {
  const handle = window.__NEXT_EDITOR_STUDIO__ ?? { runs: [], comparison: null, running: false };
  window.__NEXT_EDITOR_STUDIO__ = { ...handle, workflow };
}

function restoredWorkflow(): StudioWorkflow | null {
  const stored = loadStoredWorkflow();
  return stored ? restoreWorkflow(stored) : null;
}

/**
 * The studio console's workflow: the stored queue (resumable after a reload)
 * and the runner that takes it through its lessons with the studio's render.
 */
export function useStudioWorkflow(deps: StudioWorkflowDeps) {
  const [workflow, setWorkflow] = useState<StudioWorkflow | null>(restoredWorkflow);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  // The failed render's full report lives only in this page: it is too big to
  // keep with the queue, and the issue report already carries its findings.
  const [failedReport, setFailedReport] = useState<StudioRenderReport | null>(null);
  const queryClient = useQueryClient();
  const [runner] = useState(() =>
    createWorkflowRunner(workflow, deps, {
      commit: (next) => {
        setWorkflow(next);
        storeWorkflow(next);
        publishWorkflowHandle(next);
      },
      onActiveLesson: setActiveSlug,
      onUploadProgress: setUploadProgress,
      onFailedReport: setFailedReport,
      onSetupError: setSetupError,
      acquireScreen: () => acquireDisplayStream(true),
      storeThumbnails: storeWorkflowThumbnails,
      loadThumbnail: loadWorkflowThumbnail,
      clearThumbnails: clearWorkflowThumbnails,
      uploadDraft: uploadWorkflowDraft,
      publishDraft: publishWorkflowDraft,
      addToPlaylist: addWorkflowLessonToPlaylist,
      onLibraryChanged: () => void invalidateLessonDerivedQueries(queryClient),
      newId: () => crypto.randomUUID(),
      nowIso: () => new Date().toISOString(),
      environment: () => ({ origin: window.location.origin, userAgent: navigator.userAgent }),
    }),
  );

  useLayoutEffect(() => {
    runner.setDeps(deps);
  });

  useEffect(() => {
    // A workflow the reload stopped is written back as stopped.
    storeWorkflow(workflow);
    publishWorkflowHandle(workflow);
    // Once, for the restored workflow; every later change goes through commit.
  }, []);

  return {
    workflow,
    active: isWorkflowActive(workflow),
    activeSlug,
    uploadProgress,
    setupError,
    failedReport,
    start: runner.start,
    requestStop: runner.requestStop,
  };
}

export type StudioWorkflowApi = ReturnType<typeof useStudioWorkflow>;
