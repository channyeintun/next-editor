import { useContext } from "react";
import {
  NodeRuntimeActionsContext,
  NodeRuntimeMetadataContext,
  NodeRuntimeOutputContext,
  NodeRuntimeSaveWorkspaceContext,
  type NodeRuntimeActions,
  type NodeRuntimeMetadata,
  type NodeRuntimeOutput,
  NodeRuntimeSnapshotGetterContext,
  type SaveWorkspaceOptions,
  type NodeRuntimeRecordingSnapshot,
} from "../contexts/NodeRuntimeContext";

export const useNodeRuntimeActions = (): NodeRuntimeActions => {
  const context = useContext(NodeRuntimeActionsContext);

  if (!context) {
    throw new Error("useNodeRuntimeActions must be used within a NodeRuntimeProvider");
  }

  return context;
};

export const useNodeRuntimeSaveWorkspace = (): ((
  options?: SaveWorkspaceOptions,
) => Promise<void>) => {
  const context = useContext(NodeRuntimeSaveWorkspaceContext);

  if (!context) {
    throw new Error("useNodeRuntimeSaveWorkspace must be used within a NodeRuntimeProvider");
  }

  return context;
};

export const useNodeRuntimeSnapshotGetter = (): (() => NodeRuntimeRecordingSnapshot) => {
  const context = useContext(NodeRuntimeSnapshotGetterContext);

  if (!context) {
    throw new Error("useNodeRuntimeSnapshotGetter must be used within a NodeRuntimeProvider");
  }

  return context;
};

export const useNodeRuntimeMetadata = (): NodeRuntimeMetadata => {
  const context = useContext(NodeRuntimeMetadataContext);

  if (!context) {
    throw new Error("useNodeRuntimeMetadata must be used within a NodeRuntimeProvider");
  }

  return context;
};

/** The runner and terminal output; it changes on every streamed chunk (at most once a frame). */
export const useNodeRuntimeOutput = (): NodeRuntimeOutput => {
  const context = useContext(NodeRuntimeOutputContext);

  if (!context) {
    throw new Error("useNodeRuntimeOutput must be used within a NodeRuntimeProvider");
  }

  return context;
};
