import { useSelector } from "@xstate/store-react";
import { useCaptionStoreInstance } from "../contexts/CaptionStoreContext";
import {
  selectCaptionsEnabled,
  selectCaptionLanguage,
  selectCaptionTrackId,
  type CaptionStoreContext,
} from "../stores/captionStore";

export function useCaptionStore(): CaptionStoreContext {
  const store = useCaptionStoreInstance();
  const enabled = useSelector(store, (s) => selectCaptionsEnabled(s.context));
  const trackId = useSelector(store, (s) => selectCaptionTrackId(s.context));
  const language = useSelector(store, (s) => selectCaptionLanguage(s.context));
  return { enabled, trackId, language };
}

export function useCaptionStoreTrigger() {
  const store = useCaptionStoreInstance();
  return store.trigger;
}
