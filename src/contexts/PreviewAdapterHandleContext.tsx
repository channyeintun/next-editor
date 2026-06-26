import { createContext, useContext, useState, type PropsWithChildren } from "react";
import {
  createPreviewAdapterHandle,
  type PreviewAdapterHandle,
} from "../stores/previewAdapterHandle";

const PreviewAdapterHandleContext = createContext<PreviewAdapterHandle | null>(null);

export function PreviewAdapterHandleProvider({ children }: PropsWithChildren) {
  const [handle] = useState(createPreviewAdapterHandle);

  return <PreviewAdapterHandleContext value={handle}>{children}</PreviewAdapterHandleContext>;
}

export function usePreviewAdapterHandle(): PreviewAdapterHandle {
  const handle = useContext(PreviewAdapterHandleContext);
  if (!handle) {
    throw new Error("usePreviewAdapterHandle must be used within a PreviewAdapterHandleProvider");
  }
  return handle;
}
