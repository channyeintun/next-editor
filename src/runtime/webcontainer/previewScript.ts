import { createRrwebPreviewRecorderScript } from "../../components/preview/rrwebPreview";
import {
  RUNTIME_SNAPSHOT_MESSAGE_TYPE,
  RUNTIME_SNAPSHOT_REQUEST_MESSAGE_TYPE,
} from "../../components/preview/previewIframeUtils";
import { createIframeScreenshotBridgeScript } from "../../utils/iframeScreenshotBridge";
import { createIframeConsoleBridgeScript } from "../../utils/iframeConsoleBridge";
import { createApiClientProxyScript } from "../../utils/apiClientBridge";
import { createIframeInteractionCaptureScript } from "../../utils/iframeInteractionCapture";
import { createStudioPreviewCommandBridgeScript } from "../../utils/iframeStudioCommandBridge";

const RUNTIME_SNAPSHOT_SCRIPT_MARKER = "__NEXT_EDITOR_RUNTIME_SNAPSHOT__";
const RUNTIME_SCREENSHOT_BRIDGE_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_SCREENSHOT_BRIDGE__";
const RUNTIME_CONSOLE_BRIDGE_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_CONSOLE_BRIDGE__";
const RUNTIME_INTERACTION_CAPTURE_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_INTERACTION_CAPTURE__";
const RUNTIME_RRWEB_RECORD_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_RRWEB_RECORD__";
const RUNTIME_API_CLIENT_PROXY_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_API_CLIENT_PROXY__";
const RUNTIME_STUDIO_COMMAND_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_STUDIO_COMMAND__";

// Builds the single JS payload injected into every preview page through
// `WebContainer.setPreviewScript`. The WebContainer adds it to *all* HTML
// responses regardless of which server produced them, so the recorder runs no
// matter how the preview is rendered — static HTML, a Vite SPA, an Express
// server, or an SSR/hybrid framework like TanStack Start that assembles its
// document on the fly. Returns a raw script body (no `<script>` wrapper); the
// WebContainer supplies the tag. Both halves are guarded by per-window markers,
// so re-running on navigation (or inside an htmx fragment swap) is a no-op.
export function createRuntimePreviewScript(): string {
  const interactionCaptureScript = createIframeInteractionCaptureScript(
    RUNTIME_INTERACTION_CAPTURE_SETUP_MARKER,
    { includeMouseMove: true, includeRouteChange: true },
  );
  const consoleBridgeScript = createIframeConsoleBridgeScript(RUNTIME_CONSOLE_BRIDGE_SETUP_MARKER);

  // rrweb records the live DOM (+ inner scroll/input/mouse) for replay. The
  // recorder-only @rrweb/record IIFE is materialized at build time;
  // `slimDOMOptions.script` keeps it (and every other script) out of the
  // snapshots it produces, so the injected recorder never pollutes a recording.
  const rrwebRecordScript = createRrwebPreviewRecorderScript({
    setupMarker: RUNTIME_RRWEB_RECORD_SETUP_MARKER,
  });

  const apiClientProxyScript = createApiClientProxyScript(RUNTIME_API_CLIENT_PROXY_SETUP_MARKER);
  const screenshotBridgeScript = createIframeScreenshotBridgeScript(
    RUNTIME_SCREENSHOT_BRIDGE_SETUP_MARKER,
  );
  const studioCommandBridgeScript = createStudioPreviewCommandBridgeScript(
    RUNTIME_STUDIO_COMMAND_SETUP_MARKER,
  );

  const snapshotScript = `(function(){const marker=${JSON.stringify(
    RUNTIME_SNAPSHOT_SCRIPT_MARKER,
  )};if(window[marker])return;window[marker]=true;const responseType=${JSON.stringify(
    RUNTIME_SNAPSHOT_MESSAGE_TYPE,
  )};const requestType=${JSON.stringify(
    RUNTIME_SNAPSHOT_REQUEST_MESSAGE_TYPE,
  )};${consoleBridgeScript}${interactionCaptureScript}const minIntervalMs=100;let snapshotVersion=0;let lastSnapshotAt=-Infinity;let pendingRequestId=null;let snapshotTimer=0;const postSnapshot=(requestId)=>{try{const startedAt=performance.now();const root=document.documentElement;if(!root)return;const clone=root.cloneNode(true);if(!(clone instanceof Element))return;clone.querySelectorAll("script").forEach((script)=>script.remove());const html=clone.outerHTML;const durationMs=Math.max(0,performance.now()-startedAt);const byteLength=new TextEncoder().encode(html).byteLength;snapshotVersion+=1;lastSnapshotAt=performance.now();window.parent.postMessage({type:responseType,payload:{html,requestId,snapshotVersion,durationMs,byteLength}},"*");}catch{}};const scheduleSnapshot=(requestId)=>{pendingRequestId=requestId;if(snapshotTimer)return;const delay=Math.max(0,minIntervalMs-(performance.now()-lastSnapshotAt));snapshotTimer=window.setTimeout(()=>{snapshotTimer=0;const nextRequestId=pendingRequestId;pendingRequestId=null;postSnapshot(nextRequestId);},delay);};window.addEventListener("message",(event)=>{if(event.source!==window.parent)return;const data=event.data;if(!data||data.type!==requestType)return;const payload=data.payload;const requestId=payload&&typeof payload.requestId==="string"?payload.requestId.slice(0,128):null;scheduleSnapshot(requestId);});})();`;

  return `${rrwebRecordScript}\n${apiClientProxyScript}\n${screenshotBridgeScript}\n${studioCommandBridgeScript}\n${snapshotScript}`;
}
