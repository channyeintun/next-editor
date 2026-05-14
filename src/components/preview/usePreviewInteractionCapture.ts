import { useEffect, type RefObject } from "react";
import type { PreviewSize } from "../../types/slides";

interface UsePreviewInteractionCaptureOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  isRecording: boolean;
  isRuntimePreviewActive: boolean;
  size: PreviewSize;
}

export function usePreviewInteractionCapture({
  iframeRef,
  isRecording,
  isRuntimePreviewActive,
  size,
}: UsePreviewInteractionCaptureOptions) {
  useEffect(() => {
    if (!isRecording || isRuntimePreviewActive) {
      return;
    }

    const iframe = iframeRef.current;
    if (!iframe) {
      return;
    }

    const setupInteractionListeners = () => {
      try {
        const iframeDoc =
          iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc) {
          return;
        }

        const captureScript = `
          (function() {
            if (window.__INTERACTION_CAPTURE_SETUP__) return;
            window.__INTERACTION_CAPTURE_SETUP__ = true;
            
            function getXPath(element) {
              if (element.id) return '//*[@id="' + element.id + '"]';
              if (element === document.body) return '/html/body';
              const parent = element.parentElement;
              if (!parent) return '/' + element.tagName.toLowerCase();
              const siblings = Array.from(parent.children).filter(s => s.tagName === element.tagName);
              const index = siblings.indexOf(element) + 1;
              return getXPath(parent) + '/' + element.tagName.toLowerCase() + (siblings.length > 1 ? '[' + index + ']' : '');
            }

            function getTargetInfo(element) {
              return {
                tagName: element.tagName.toLowerCase(),
                id: element.id || undefined,
                className: element.className || undefined,
                xpath: getXPath(element)
              };
            }

            function emit(type, target, data) {
              window.parent.postMessage({
                type: 'IFRAME_INTERACTION',
                payload: {
                  type: type,
                  target: getTargetInfo(target),
                  targetTag: target.tagName,
                  data: data
                }
              }, '*');
            }

            document.addEventListener('click', (e) => {
              emit('click', e.target, { clientX: e.clientX, clientY: e.clientY, button: e.button });
            }, true);

            document.addEventListener('mouseenter', (e) => {
              if (e.target !== document.body && e.target instanceof Element) {
                emit('hover_start', e.target, { clientX: e.clientX, clientY: e.clientY });
              }
            }, true);

            document.addEventListener('mouseleave', (e) => {
              if (e.target !== document.body && e.target instanceof Element) {
                emit('hover_end', e.target);
              }
            }, true);

            document.addEventListener('focus', (e) => {
              if (e.target instanceof Element) emit('focus', e.target);
            }, true);

            document.addEventListener('blur', (e) => {
              if (e.target instanceof Element) emit('blur', e.target);
            }, true);

            document.addEventListener('keydown', (e) => {
              if (e.target instanceof Element) emit('keydown', e.target, { key: e.key, code: e.code });
            }, true);

            document.addEventListener('keyup', (e) => {
              if (e.target instanceof Element) emit('keyup', e.target, { key: e.key, code: e.code });
            }, true);

            document.addEventListener('input', (e) => {
              const tag = e.target.tagName.toLowerCase();
              if (tag === 'input' || tag === 'textarea') {
                emit('input', e.target, { value: e.target.value });
              }
            }, true);

            let scrollTicking = false;
            document.addEventListener('scroll', (e) => {
              if (scrollTicking) return;
              
              const target = e.target;
              scrollTicking = true;
              
              requestAnimationFrame(() => {
                if (target === document || target === window || target === document.body || target === document.documentElement) {
                  const doc = document.scrollingElement || document.documentElement;
                  emit('scroll', document.body, { 
                    scrollTop: doc.scrollTop, 
                    scrollLeft: doc.scrollLeft,
                    isDocument: true
                  });
                } else if (target instanceof Element) {
                  emit('scroll', target, { 
                    scrollTop: target.scrollTop, 
                    scrollLeft: target.scrollLeft,
                    isDocument: false
                  });
                }
                scrollTicking = false;
              });
            }, true);
          })();
        `;

        const scriptElement = iframeDoc.createElement("script");
        scriptElement.textContent = captureScript;
        if (iframeDoc.head) {
          iframeDoc.head.appendChild(scriptElement);
        } else {
          iframeDoc.documentElement.appendChild(scriptElement);
        }

        return () => undefined;
      } catch (error) {
        console.warn(
          "Cannot track interactions in iframe (likely cross-origin):",
          error,
        );
        return undefined;
      }
    };

    let cleanup: (() => void) | undefined;

    const handleIframeLoad = () => {
      cleanup?.();
      cleanup = setupInteractionListeners();
    };

    iframe.addEventListener("load", handleIframeLoad);
    cleanup = setupInteractionListeners();

    return () => {
      iframe.removeEventListener("load", handleIframeLoad);
      cleanup?.();
    };
  }, [iframeRef, isRecording, isRuntimePreviewActive, size]);
}
