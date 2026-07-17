import { sanitizeSlideContent } from "./sanitizeSlideContent";

export const SLIDE_ANIMATION_INIT_MESSAGE_TYPE = "NEXT_EDITOR_SLIDE_ANIMATION_INIT";
export const SLIDE_ANIMATION_REVEAL_MESSAGE_TYPE = "NEXT_EDITOR_SLIDE_ANIMATION_REVEAL";

const SLIDE_ANIMATION_SCRIPT_NONCE = "next-editor-slide-animation";

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
// never sends slide markup back or exposes its DOM to the host document.
const SLIDE_ANIMATION_BRIDGE_SCRIPT = `(function(){
  var initType=${JSON.stringify(SLIDE_ANIMATION_INIT_MESSAGE_TYPE)};
  var revealType=${JSON.stringify(SLIDE_ANIMATION_REVEAL_MESSAGE_TYPE)};
  var timeline={entries:[],stepEndTimes:[],total:0};
  var revealed=0;
  var hasRevealed=false;
  var rafId=null;
  function finite(value,fallback){return typeof value==="number"&&Number.isFinite(value)?value:fallback;}
  function clampTime(value){return Math.min(60000,Math.max(0,finite(value,0)));}
  function buildTimeline(steps){
    var entries=[];var stepEndTimes=[];var cursor=0;var entryCount=0;
    if(!Array.isArray(steps))return{entries:entries,stepEndTimes:stepEndTimes,total:0};
    for(var stepIndex=0;stepIndex<steps.length&&stepIndex<1000&&entryCount<10000;stepIndex+=1){
      var step=steps[stepIndex];var stepLength=0;
      if(Array.isArray(step))for(var index=0;index<step.length&&entryCount<10000;index+=1){
        var source=step[index];if(!source||typeof source!=="object"||typeof source.elementId!=="string"||source.elementId.length>1024)continue;
        var tracks=[];var sourceTracks=Array.isArray(source.tracks)?source.tracks:[];
        for(var trackIndex=0;trackIndex<sourceTracks.length&&trackIndex<4;trackIndex+=1){
          var track=sourceTracks[trackIndex];if(!track||typeof track!=="object")continue;
          if(track.kind==="opacity"||track.kind==="scale")tracks.push({kind:track.kind,from:finite(track.from,0),to:finite(track.to,0)});
          else if(track.kind==="translate")tracks.push({kind:"translate",fromX:finite(track.fromX,0),fromY:finite(track.fromY,0),toX:finite(track.toX,0),toY:finite(track.toY,0)});
        }
        var delay=clampTime(source.delayMs);var duration=clampTime(source.durationMs);var start=cursor+delay;var end=start+duration;
        entries.push({elementId:source.elementId,tracks:tracks,start:start,end:end});entryCount+=1;stepLength=Math.max(stepLength,delay+duration);
      }
      cursor+=stepLength;stepEndTimes.push(cursor);
    }
    return{entries:entries,stepEndTimes:stepEndTimes,total:cursor};
  }
  function ease(t){return t<0.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;}
  function apply(time){
    var styles=new Map();
    for(var index=0;index<timeline.entries.length;index+=1){
      var item=timeline.entries[index];var duration=item.end-item.start;var linear=duration<=0?(time>=item.end?1:0):Math.min(Math.max((time-item.start)/duration,0),1);var eased=ease(linear);var style=styles.get(item.elementId)||{};
      for(var trackIndex=0;trackIndex<item.tracks.length;trackIndex+=1){
        var track=item.tracks[trackIndex];
        if(track.kind==="opacity")style.opacity=track.from+(track.to-track.from)*linear;
        else if(track.kind==="scale")style.transform="scale("+(track.from+(track.to-track.from)*eased)+")";
        else style.transform="translate("+((track.fromX+(track.toX-track.fromX)*eased)*100)+"%, "+((track.fromY+(track.toY-track.fromY)*eased)*100)+"%)";
      }
      styles.set(item.elementId,style);
    }
    styles.forEach(function(style,id){var element=document.getElementById(id);if(!element||!("style" in element))return;if(style.opacity!==undefined)element.style.opacity=String(style.opacity);element.style.transform=style.transform||"";});
  }
  function timeFor(count){if(count<=0)return 0;if(count>=timeline.stepEndTimes.length)return timeline.total;return timeline.stepEndTimes[count-1];}
  function cancel(){if(rafId!==null){cancelAnimationFrame(rafId);rafId=null;}}
  function setRevealed(value,animate){
    cancel();var next=Math.max(0,Math.trunc(finite(value,0)));var target=timeFor(next);var from=timeFor(revealed);var singleForward=animate&&hasRevealed&&next===revealed+1;revealed=next;hasRevealed=true;
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
  { animationBridge = false }: SandboxedSlideDocumentOptions = {},
): string {
  const sanitized = sanitizeSlideContent(content, mimeType);
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
