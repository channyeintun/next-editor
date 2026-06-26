import { createContext, useContext, useEffect, useState, type PropsWithChildren } from "react";
import {
  createSlidesStore,
  saveSlidesToStorage,
  type SlideNavigator,
  type SlidesStoreInstance,
} from "../stores/slidesStore";

interface SlidesStoreContextValue {
  store: SlidesStoreInstance;
  /** Imperative reveal.js navigation handle, applied during replay (tier c). */
  navigator: { current: SlideNavigator | null };
}

const SlidesStoreContext = createContext<SlidesStoreContextValue | null>(null);

export function SlidesStoreProvider({ children }: PropsWithChildren) {
  const [value] = useState<SlidesStoreContextValue>(() => ({
    store: createSlidesStore(),
    navigator: { current: null },
  }));

  // Persist slides to localStorage whenever they change.
  useEffect(() => {
    const { store } = value;
    let previousSlides = store.getSnapshot().context.slides;
    const subscription = store.subscribe((snapshot) => {
      if (snapshot.context.slides !== previousSlides) {
        previousSlides = snapshot.context.slides;
        saveSlidesToStorage(previousSlides);
      }
    });

    return () => subscription.unsubscribe();
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
