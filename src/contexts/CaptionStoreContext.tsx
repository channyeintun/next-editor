import { createContext, useContext, useState, type PropsWithChildren } from "react";
import { createCaptionStore, type CaptionStoreInstance } from "../stores/captionStore";

const CaptionStoreContext = createContext<CaptionStoreInstance | null>(null);

export function CaptionStoreProvider({ children }: PropsWithChildren) {
  const [store] = useState(() => createCaptionStore());
  return <CaptionStoreContext value={store}>{children}</CaptionStoreContext>;
}

export function useCaptionStoreInstance(): CaptionStoreInstance {
  const store = useContext(CaptionStoreContext);
  if (!store) {
    throw new Error("useCaptionStoreInstance must be used within a CaptionStoreProvider");
  }
  return store;
}
