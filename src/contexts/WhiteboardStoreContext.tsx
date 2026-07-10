import { createContext, useContext, useState, type PropsWithChildren } from "react";
import { createWhiteboardStore, type WhiteboardStoreInstance } from "../stores/whiteboardStore";

interface WhiteboardStoreContextValue {
  store: WhiteboardStoreInstance;
}

const WhiteboardStoreContext = createContext<WhiteboardStoreContextValue | null>(null);

export function WhiteboardStoreProvider({ children }: PropsWithChildren) {
  const [value] = useState<WhiteboardStoreContextValue>(() => ({
    store: createWhiteboardStore(),
  }));

  return <WhiteboardStoreContext value={value}>{children}</WhiteboardStoreContext>;
}

export function useWhiteboardStore(): WhiteboardStoreContextValue {
  const value = useContext(WhiteboardStoreContext);
  if (!value) {
    throw new Error("useWhiteboardStore must be used within a WhiteboardStoreProvider");
  }
  return value;
}
