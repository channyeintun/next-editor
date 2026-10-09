import { buildTimeline, sampleStyles, timeForRevealed } from "../googleSlides/animator";
import { sanitizeSlideContent } from "./sanitizeSlideContent";

export const SLIDE_ANIMATION_INIT_MESSAGE_TYPE = "NEXT_EDITOR_SLIDE_ANIMATION_INIT";
export const SLIDE_ANIMATION_REVEAL_MESSAGE_TYPE = "NEXT_EDITOR_SLIDE_ANIMATION_REVEAL";

// Generated once per page load rather than hardcoded. A CSP nonce is only a
// control if content cannot predict it: as a source literal it was readable in
// the shipped bundle, so `script-src 'nonce-<constant>'` was equivalent to
// 'unsafe-inline' for any authored slide that simply spelled the constant out.
// Slide markup is authored ahead of time and rendered in an opaque-origin
// frame, so it can never observe this value. Stable across renders on purpose —
// a fresh nonce per call would change srcDoc and reload every slide frame.
// sanitizeSlideContent also strips `nonce` from authored markup.
const SLIDE_ANIMATION_SCRIPT_NONCE = crypto.randomUUID();

function createSlideContentSecurityPolicy(animationBridge: boolean): string {
  return [
    "default-src 'none'",
    animationBridge ? `script-src 'nonce-${SLIDE_ANIMATION_SCRIPT_NONCE}'` : "script-src 'none'",
    "img-src https: data: blob:",
    "media-src https: data: blob:",
    "font-src data:",
    "style-src 'unsafe-inline'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

// Runs only in the unique-origin Google-SVG frame. Authored/imported scripts
// are removed before this trusted bridge is appended, and the CSP nonce allows
// only this script. The parent sends structured animation state; the child
// never sends slide markup back or exposes its DOM to the host document. The
// timeline math is inlined from googleSlides/animator.ts (single source of
// truth, unit-tested there); this script adds only the DOM writes, the
// snap-then-animate reveal rule and the message protocol.
const SLIDE_ANIMATION_BRIDGE_SCRIPT = `(function(){
  var initType=${JSON.stringify(SLIDE_ANIMATION_INIT_MESSAGE_TYPE)};
  var revealType=${JSON.stringify(SLIDE_ANIMATION_REVEAL_MESSAGE_TYPE)};
  var buildTimeline=${buildTimeline.toString()};
  var sampleStyles=${sampleStyles.toString()};
  var timeForRevealed=${timeForRevealed.toString()};
  var timeline={entries:[],stepEndTimes:[],total:0};
  var revealed=0;
  var hasRevealed=false;
  var rafId=null;
  function finite(value,fallback){return typeof value==="number"&&Number.isFinite(value)?value:fallback;}
  function apply(time){
    sampleStyles(timeline,time).forEach(function(style,id){var element=document.getElementById(id);if(!element||!("style" in element))return;if(style.opacity!==undefined)element.style.opacity=String(style.opacity);element.style.transform=style.transform||"";});
  }
  function cancel(){if(rafId!==null){cancelAnimationFrame(rafId);rafId=null;}}
  function setRevealed(value,animate){
    cancel();var next=Math.max(0,Math.trunc(finite(value,0)));var target=timeForRevealed(timeline,next);var from=timeForRevealed(timeline,revealed);var singleForward=animate&&hasRevealed&&next===revealed+1;revealed=next;hasRevealed=true;
    if(!singleForward||target<=from||typeof requestAnimationFrame!=="function"){apply(target);return;}
    var wallDuration=target-from;var started=performance.now();
    function tick(){var elapsed=performance.now()-started;var progress=wallDuration<=0?1:Math.min(elapsed/wallDuration,1);apply(from+(target-from)*progress);if(progress<1)rafId=requestAnimationFrame(tick);else rafId=null;}
    rafId=requestAnimationFrame(tick);
  }
  window.addEventListener("message",function(event){
    if(event.source!==parent||!event.data)return;
    if(event.data.type===initType){cancel();timeline=buildTimeline(event.data.steps);revealed=0;hasRevealed=false;apply(0);setRevealed(event.data.stepsRevealed,false);}
    else if(event.data.type===revealType)setRevealed(event.data.stepsRevealed,true);
  });
})();`;

interface SandboxedSlideDocumentOptions {
  animationBridge?: boolean;
  /** Image href → data: URL, for images the page already fetched (slideImageCache.ts). */
  inlineImages?: ReadonlyMap<string, string>;
}

/**
 * Build an isolated iframe document for authored/imported slide markup. Raw
 * HTML/markdown remains script-disabled; Google SVG frames may opt into the one
 * nonce-restricted animation bridge above. CSS remains inside the frame, while
 * CSP blocks authored scripts, stylesheets, forms, network APIs, and base URLs.
 */
export function createSandboxedSlideDocument(
  content: string,
  mimeType: "text/html" | "image/svg+xml",
  { animationBridge = false, inlineImages }: SandboxedSlideDocumentOptions = {},
): string {
  const sanitized = sanitizeSlideContent(content, mimeType, inlineImages);
  const trustedAnimationScript = animationBridge
    ? `<script nonce="${SLIDE_ANIMATION_SCRIPT_NONCE}">${SLIDE_ANIMATION_BRIDGE_SCRIPT}</script>`
    : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${createSlideContentSecurityPolicy(animationBridge)}">
    <meta name="referrer" content="no-referrer">
    <meta name="color-scheme" content="dark">
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #000; color-scheme: dark; }
      body { display: flex; align-items: center; justify-content: center; }
      body > svg { display: block; width: 100%; height: auto; }
    </style>
  </head>
  <body>${sanitized}${trustedAnimationScript}</body>
</html>`;
}
