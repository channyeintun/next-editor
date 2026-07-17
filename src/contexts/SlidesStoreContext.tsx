import { createContext, useContext, useEffect, useState, type PropsWithChildren } from "react";
import {
  createSlidesStore,
  subscribeSlidesPersistence,
  type SlidesStoreInstance,
} from "../stores/slidesStore";

interface SlidesStoreContextValue {
  store: SlidesStoreInstance;
}

const SlidesStoreContext = createContext<SlidesStoreContextValue | null>(null);

export function SlidesStoreProvider({ children }: PropsWithChildren) {
  const [value] = useState<SlidesStoreContextValue>(() => ({
    store: createSlidesStore(),
  }));

  // Persist slides to localStorage whenever they change.
  useEffect(() => {
    return subscribeSlidesPersistence(value.store);
  }, [value]);

  return <SlidesStoreContext value={value}>{children}</SlidesStoreContext>;
}

export function useSlidesStore(): SlidesStoreContextValue {
  const value = useContext(SlidesStoreContext);
  if (!value) {
    throw new Error("useSlidesStore must be used within a SlidesStoreProvider");
  }
  return value;
}
