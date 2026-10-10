import { requestFromPreviewFrame } from "./previewFrameRequest";

export const PREVIEW_SCREENSHOT_REQUEST_MESSAGE_TYPE = "NEXT_EDITOR_PREVIEW_SCREENSHOT_REQUEST";
export const PREVIEW_SCREENSHOT_RESPONSE_MESSAGE_TYPE = "NEXT_EDITOR_PREVIEW_SCREENSHOT_RESPONSE";

export interface PreviewScreenshotResult {
  dataUrl: string;
  height: number;
  width: number;
}

export function requestPreviewScreenshot(
  iframe: HTMLIFrameElement | null,
  timeoutMs = 10_000,
): Promise<PreviewScreenshotResult> {
  return requestFromPreviewFrame({
    iframe,
    requestType: PREVIEW_SCREENSHOT_REQUEST_MESSAGE_TYPE,
    responseType: PREVIEW_SCREENSHOT_RESPONSE_MESSAGE_TYPE,
    idPrefix: `preview-shot-${Date.now().toString(36)}`,
    timeoutMs,
    parse: ({ dataUrl, width, height }) =>
      typeof dataUrl === "string" &&
      dataUrl.startsWith("data:image/png;base64,") &&
      typeof width === "number" &&
      typeof height === "number"
        ? { dataUrl, width, height }
        : undefined,
    messages: {
      unavailable: "The live preview iframe is not available.",
      invalid: "The preview returned an invalid screenshot.",
      timedOut: `Preview screenshot timed out after ${timeoutMs}ms.`,
    },
  });
}

export function createIframeScreenshotBridgeScript(setupMarker: string): string {
  return `
    (function() {
      var marker = ${JSON.stringify(setupMarker)};
      if (window[marker]) return;
      window[marker] = true;

      var requestType = ${JSON.stringify(PREVIEW_SCREENSHOT_REQUEST_MESSAGE_TYPE)};
      var responseType = ${JSON.stringify(PREVIEW_SCREENSHOT_RESPONSE_MESSAGE_TYPE)};

      function post(id, result) {
        try {
          window.parent.postMessage({ type: responseType, payload: Object.assign({ id: id }, result) }, '*');
        } catch {}
      }

      function syncRenderedState(sourceRoot, cloneRoot) {
        var sourceFields = sourceRoot.querySelectorAll('input, textarea, select');
        var cloneFields = cloneRoot.querySelectorAll('input, textarea, select');
        sourceFields.forEach(function(source, index) {
          var clone = cloneFields[index];
          if (!clone) return;
          if (source.tagName === 'TEXTAREA') clone.textContent = source.value;
          if (source.tagName === 'SELECT') clone.value = source.value;
          if (source.tagName === 'INPUT') {
            clone.setAttribute('value', source.value || '');
            if (source.checked) clone.setAttribute('checked', '');
            else clone.removeAttribute('checked');
          }
        });

        var sourceCanvases = sourceRoot.querySelectorAll('canvas');
        var cloneCanvases = cloneRoot.querySelectorAll('canvas');
        sourceCanvases.forEach(function(source, index) {
          var clone = cloneCanvases[index];
          if (!clone) return;
          try {
            var image = document.createElement('img');
            image.src = source.toDataURL('image/png');
            image.width = source.clientWidth || source.width;
            image.height = source.clientHeight || source.height;
            clone.replaceWith(image);
          } catch {}
        });

        var sourceImages = sourceRoot.querySelectorAll('img');
        var cloneImages = cloneRoot.querySelectorAll('img');
        sourceImages.forEach(function(source, index) {
          var clone = cloneImages[index];
          if (clone && source.currentSrc) clone.setAttribute('src', source.currentSrc);
        });
      }

      function loadImage(url) {
        return new Promise(function(resolve, reject) {
          var image = new Image();
          image.onload = function() { resolve(image); };
          image.onerror = function() { reject(new Error('The browser could not render the preview snapshot.')); };
          image.src = url;
        });
      }

      async function capture(id) {
        var width = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
        var height = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
        var clone = document.documentElement.cloneNode(true);

        clone.querySelectorAll('script').forEach(function(node) { node.remove(); });
        syncRenderedState(document.documentElement, clone);
        clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
        clone.style.width = width + 'px';
        clone.style.height = height + 'px';
        clone.style.overflow = 'hidden';
        clone.style.transformOrigin = '0 0';
        clone.style.transform = 'translate(' + (-window.scrollX) + 'px,' + (-window.scrollY) + 'px)';

        var serialized = new XMLSerializer().serializeToString(clone);
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><foreignObject width="100%" height="100%">' + serialized + '</foreignObject></svg>';
        var objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));

        try {
          var image = await loadImage(objectUrl);
          var canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          var context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas rendering is unavailable in this preview.');
          context.drawImage(image, 0, 0, width, height);
          post(id, { dataUrl: canvas.toDataURL('image/png'), width: width, height: height });
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      }

      window.addEventListener('message', function(event) {
        if (event.source !== window.parent || !event.data || event.data.type !== requestType) return;
        var id = event.data.payload && event.data.payload.id;
        if (typeof id !== 'string') return;
        capture(id).catch(function(error) {
          post(id, { error: error instanceof Error ? error.message : String(error) });
        });
      });
    })();
  `;
}
