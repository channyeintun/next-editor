import { useContext } from "react";
import {
  WebContainerRuntimeActionsContext,
  WebContainerRuntimeMetadataContext,
  type WebContainerRuntimeActions,
  type WebContainerRuntimeMetadata,
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

export const useWebContainerRuntimeMetadata =
  (): WebContainerRuntimeMetadata => {
    const context = useContext(WebContainerRuntimeMetadataContext);

    if (!context) {
      throw new Error(
        "useWebContainerRuntimeMetadata must be used within a WebContainerRuntimeProvider",
      );
    }

    return context;
  };
