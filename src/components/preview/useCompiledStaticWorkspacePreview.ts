import { useMemo } from "react";
import { useWorkspaceActions, useWorkspacePreviewVersion } from "../../hooks/useWorkspace";
import { createStaticWorkspacePreview } from "./staticWorkspacePreview";

export function useCompiledStaticWorkspacePreview(): string {
  const { getProject } = useWorkspaceActions();
  const previewVersion = useWorkspacePreviewVersion();

  return useMemo(() => {
    void previewVersion;
    return createStaticWorkspacePreview(getProject());
  }, [getProject, previewVersion]);
}
