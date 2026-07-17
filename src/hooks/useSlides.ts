import { useEffect, useState } from "react";
import type { SlideEvent } from "../types/slides";
import {
  createSlidesStore,
  subscribeSlidesPersistence,
} from "../stores/slidesStore";
import { useSlidesController } from "./useSlidesController";

interface UseSlidesConfig {
  onSlideEvent?: (event: SlideEvent) => void;
}

/**
 * Standalone public slide API. The application provider and this hook now share
 * the same store-backed controller; this wrapper only owns lifecycle/persistence.
 */
export const useSlides = ({ onSlideEvent }: UseSlidesConfig = {}) => {
  const [store] = useState(createSlidesStore);

  useEffect(() => subscribeSlidesPersistence(store), [store]);

  return useSlidesController({ store, onSlideEvent });
};
