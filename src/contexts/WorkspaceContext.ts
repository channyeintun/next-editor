import { createContext } from "react";
import type { WorkspaceActions } from "../stores/workspaceActions";
import type { WorkspaceStoreInstance } from "../stores/workspaceStore";

export const WorkspaceActionsContext = createContext<WorkspaceActions | null>(null);
export const WorkspaceStoreContext = createContext<WorkspaceStoreInstance | null>(null);
