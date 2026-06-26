import { createContext, useContext, useState, type PropsWithChildren } from "react";
import { createSlidesStore, type SlidesStore } from "../stores/slidesStore";

const SlidesStoreContext = createContext<SlidesStore | null>(null);

export function SlidesStoreProvider({ children }: PropsWithChildren) {
  const [store] = useState(createSlidesStore);

  return <SlidesStoreContext value={store}>{children}</SlidesStoreContext>;
}

export function useSlidesStore(): SlidesStore {
  const store = useContext(SlidesStoreContext);
  if (!store) {
    throw new Error("useSlidesStore must be used within a SlidesStoreProvider");
  }
  return store;
}
