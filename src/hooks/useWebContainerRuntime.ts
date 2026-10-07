import { useContext } from "react";
import {
  WebContainerRuntimeActionsContext,
  WebContainerRuntimeMetadataContext,
  WebContainerRuntimeOutputContext,
  WebContainerRuntimeSaveWorkspaceContext,
  type WebContainerRuntimeActions,
  type WebContainerRuntimeMetadata,
  type WebContainerRuntimeOutput,
  WebContainerRuntimeSnapshotGetterContext,
  type WebContainerRuntimeRecordingSnapshot,
} from "../contexts/WebContainerRuntimeContext";

export const useWebContainerRuntimeActions = (): WebContainerRuntimeActions => {
  const context = useContext(WebContainerRuntimeActionsContext);

  if (!context) {
    throw new Error(
      "useWebContainerRuntimeActions must be used within a WebContainerRuntimeProvider",
    );
  }

  return context;
};

export const useWebContainerRuntimeSaveWorkspace = (): (() => Promise<void>) => {
  const context = useContext(WebContainerRuntimeSaveWorkspaceContext);

  if (!context) {
    throw new Error(
      "useWebContainerRuntimeSaveWorkspace must be used within a WebContainerRuntimeProvider",
    );
  }

  return context;
};

export const useWebContainerRuntimeSnapshotGetter =
  (): (() => WebContainerRuntimeRecordingSnapshot) => {
    const context = useContext(WebContainerRuntimeSnapshotGetterContext);

    if (!context) {
      throw new Error(
        "useWebContainerRuntimeSnapshotGetter must be used within a WebContainerRuntimeProvider",
      );
    }

    return context;
  };

export const useWebContainerRuntimeMetadata = (): WebContainerRuntimeMetadata => {
  const context = useContext(WebContainerRuntimeMetadataContext);

  if (!context) {
    throw new Error(
      "useWebContainerRuntimeMetadata must be used within a WebContainerRuntimeProvider",
    );
  }

  return context;
};

/** The runner and terminal output; it changes on every streamed chunk (at most once a frame). */
export const useWebContainerRuntimeOutput = (): WebContainerRuntimeOutput => {
  const context = useContext(WebContainerRuntimeOutputContext);

  if (!context) {
    throw new Error(
      "useWebContainerRuntimeOutput must be used within a WebContainerRuntimeProvider",
    );
  }

  return context;
};
