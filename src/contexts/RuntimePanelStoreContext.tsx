import { createContext, useContext, useState, type PropsWithChildren } from "react";
import {
  createRuntimePanelStore,
  type ConsoleAppender,
  type ConsoleOpener,
  type RuntimePanelStoreInstance,
} from "../stores/runtimePanelStore";

interface RuntimePanelStoreContextValue {
  store: RuntimePanelStoreInstance;
  /** Imperative handles owned by the runtime panel (tier c). */
  consoleAppender: { current: ConsoleAppender | null };
  consoleOpener: { current: ConsoleOpener | null };
}

const RuntimePanelStoreContext = createContext<RuntimePanelStoreContextValue | null>(null);

export function RuntimePanelStoreProvider({ children }: PropsWithChildren) {
  const [value] = useState<RuntimePanelStoreContextValue>(() => ({
    store: createRuntimePanelStore(),
    consoleAppender: { current: null },
    consoleOpener: { current: null },
  }));

  return <RuntimePanelStoreContext value={value}>{children}</RuntimePanelStoreContext>;
}

export function useRuntimePanelStore(): RuntimePanelStoreContextValue {
  const value = useContext(RuntimePanelStoreContext);
  if (!value) {
    throw new Error("useRuntimePanelStore must be used within a RuntimePanelStoreProvider");
  }
  return value;
}
