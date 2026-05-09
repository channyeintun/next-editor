import { useContext } from "react";
import {
  WorkspaceActionsContext,
  WorkspaceMetadataContext,
  type WorkspaceActions,
  type WorkspaceMetadata,
} from "../contexts/WorkspaceContext";

export const useWorkspaceActions = (): WorkspaceActions => {
  const context = useContext(WorkspaceActionsContext);

  if (!context) {
    throw new Error(
      "useWorkspaceActions must be used within a WorkspaceProvider",
    );
  }

  return context;
};

export const useWorkspaceMetadata = (): WorkspaceMetadata => {
  const context = useContext(WorkspaceMetadataContext);

  if (!context) {
    throw new Error(
      "useWorkspaceMetadata must be used within a WorkspaceProvider",
    );
  }

  return context;
};
