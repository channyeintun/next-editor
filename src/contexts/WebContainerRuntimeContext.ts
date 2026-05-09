import { createContext } from "react";

export type WebContainerRuntimeStatus =
  | "idle"
  | "booting"
  | "mounting"
  | "installing"
  | "starting"
  | "ready"
  | "error";

export interface WebContainerRuntimeActions {
  startRuntime: () => Promise<void>;
  resetRuntime: () => void;
}

export interface WebContainerRuntimeMetadata {
  status: WebContainerRuntimeStatus;
  previewUrl: string | null;
  isSupported: boolean;
  errorMessage: string | null;
  lastOutput: string | null;
}

export const WebContainerRuntimeActionsContext =
  createContext<WebContainerRuntimeActions | null>(null);

export const WebContainerRuntimeMetadataContext =
  createContext<WebContainerRuntimeMetadata | null>(null);
