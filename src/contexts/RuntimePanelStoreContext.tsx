import { createContext, useContext, useState, type PropsWithChildren } from "react";
import { createRuntimePanelStore, type RuntimePanelStore } from "../stores/runtimePanelStore";

const RuntimePanelStoreContext = createContext<RuntimePanelStore | null>(null);

export function RuntimePanelStoreProvider({ children }: PropsWithChildren) {
  const [store] = useState(createRuntimePanelStore);

  return <RuntimePanelStoreContext value={store}>{children}</RuntimePanelStoreContext>;
}

export function useRuntimePanelStore(): RuntimePanelStore {
  const store = useContext(RuntimePanelStoreContext);
  if (!store) {
    throw new Error("useRuntimePanelStore must be used within a RuntimePanelStoreProvider");
  }
  return store;
}
