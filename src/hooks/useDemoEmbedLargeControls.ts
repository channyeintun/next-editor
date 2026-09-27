import { useEffect, useState } from "react";
import {
  DEMO_CONTROLS_SIZE_MESSAGE_TYPE,
  DEMO_EMBED_READY_MESSAGE_TYPE,
} from "../utils/demoEmbedControls";

/**
 * The control size a same-origin parent frame (the landing page's demo embed)
 * asks for at runtime, or null until it asks. It boots us with
 * ?largeControls=true while scaled down, then asks for regular controls when
 * its fullscreen mode shows us at native size. Readiness is announced after
 * subscribing so a size change from before this (lazily loaded) editor mounted
 * gets re-delivered. A cross-origin parent never gets the announce
 * (targetOrigin mismatch drops it) and its messages fail the origin check.
 */
export function useDemoEmbedLargeControls(): boolean | null {
  const [largeControls, setLargeControls] = useState<boolean | null>(null);

  useEffect(() => {
    if (window.parent === window) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== window.parent) return;
      const data = event.data as { type?: unknown; large?: unknown } | null;
      if (data?.type !== DEMO_CONTROLS_SIZE_MESSAGE_TYPE || typeof data.large !== "boolean") {
        return;
      }
      setLargeControls(data.large);
    };
    window.addEventListener("message", handleMessage);
    window.parent.postMessage({ type: DEMO_EMBED_READY_MESSAGE_TYPE }, window.location.origin);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return largeControls;
}
