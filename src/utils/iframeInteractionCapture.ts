export const IFRAME_INTERACTION_MESSAGE_TYPE = "IFRAME_INTERACTION";
export const IFRAME_NAVIGATION_COMMAND_MESSAGE_TYPE = "IFRAME_NAVIGATION_COMMAND";

interface IframeInteractionCaptureScriptOptions {
  includeMouseMove?: boolean;
  includeRouteChange?: boolean;
}

export function createIframeInteractionCaptureScript(
  setupMarker: string,
  options?: IframeInteractionCaptureScriptOptions,
): string {
  const includeMouseMove = options?.includeMouseMove ?? false;
  const includeRouteChange = options?.includeRouteChange ?? false;

  return `
    (function() {
      const marker = ${JSON.stringify(setupMarker)};
      const cleanupMarker = marker + ':cleanup';

      if (typeof window[cleanupMarker] === 'function') {
        window[cleanupMarker]();
      }

      if (window[marker]) return;
      window[marker] = true;

      const messageType = ${JSON.stringify(IFRAME_INTERACTION_MESSAGE_TYPE)};
      const navigationCommandMessageType = ${JSON.stringify(IFRAME_NAVIGATION_COMMAND_MESSAGE_TYPE)};
      const includeMouseMove = ${JSON.stringify(includeMouseMove)};
      const includeRouteChange = ${JSON.stringify(includeRouteChange)};
      const cleanupCallbacks = [];
      let pendingMouseMove = null;
      let mouseMoveFrame = 0;
      let lastMouseMoveSignature = '';
      let pendingScrollTarget = null;
      let scrollFrame = 0;
      let scrollTicking = false;

      function addWindowListener(type, listener, options) {
        window.addEventListener(type, listener, options);
        cleanupCallbacks.push(function() {
          window.removeEventListener(type, listener, options);
        });
      }

      function addDocumentListener(type, listener, options) {
        document.addEventListener(type, listener, options);
        cleanupCallbacks.push(function() {
          document.removeEventListener(type, listener, options);
        });
      }

      function cleanupInteractionCapture() {
        while (cleanupCallbacks.length) {
          const cleanup = cleanupCallbacks.pop();

          try {
            cleanup();
          } catch {}
        }

        if (mouseMoveFrame) {
          window.cancelAnimationFrame(mouseMoveFrame);
          mouseMoveFrame = 0;
        }

        if (scrollFrame) {
          window.cancelAnimationFrame(scrollFrame);
          scrollFrame = 0;
        }

        pendingMouseMove = null;
        pendingScrollTarget = null;
        scrollTicking = false;

        try {
          delete window[marker];
          delete window[cleanupMarker];
        } catch {
          window[marker] = false;
          window[cleanupMarker] = undefined;
        }
      }

      window[cleanupMarker] = cleanupInteractionCapture;

      function getXPath(element) {
        if (element.id) return '//*[@id="' + element.id + '"]';
        if (element === document.body) return '/html/body';
        const parent = element.parentElement;
        if (!parent) return '/' + element.tagName.toLowerCase();
        const siblings = Array.from(parent.children).filter(
          (sibling) => sibling.tagName === element.tagName,
        );
        const index = siblings.indexOf(element) + 1;
        return (
          getXPath(parent) +
          '/' +
          element.tagName.toLowerCase() +
          (siblings.length > 1 ? '[' + index + ']' : '')
        );
      }

      function getTargetInfo(element) {
        return {
          tagName: element.tagName.toLowerCase(),
          id: element.id || undefined,
          className: element.className || undefined,
          xpath: getXPath(element),
        };
      }

      function emit(type, target, data) {
        if (!(target instanceof Element)) {
          return;
        }

        window.parent.postMessage(
          {
            type: messageType,
            payload: {
              type,
              target: getTargetInfo(target),
              targetTag: target.tagName,
              data,
            },
          },
          '*',
        );
      }

      let lastRoute = null;

      function getCurrentRoute() {
        const pathname = window.location.pathname || '/';
        return pathname + (window.location.search || '') + (window.location.hash || '');
      }

      function emitRouteChange() {
        if (!includeRouteChange) {
          return;
        }

        const route = getCurrentRoute();
        if (route === lastRoute) {
          return;
        }

        lastRoute = route;
        window.parent.postMessage(
          {
            type: messageType,
            payload: {
              type: 'route_change',
              data: {
                href: window.location.href,
                pathname: window.location.pathname || '/',
                search: window.location.search || '',
                hash: window.location.hash || '',
                route,
              },
            },
          },
          '*',
        );
      }

      if (includeRouteChange) {
        const wrapHistoryMethod = (methodName) => {
          const originalMethod = window.history && window.history[methodName];

          if (typeof originalMethod !== 'function') {
            return;
          }

          const wrappedMethod = function() {
            const result = originalMethod.apply(this, arguments);
            emitRouteChange();
            return result;
          };

          window.history[methodName] = wrappedMethod;
          cleanupCallbacks.push(function() {
            if (window.history && window.history[methodName] === wrappedMethod) {
              window.history[methodName] = originalMethod;
            }
          });
        };

        wrapHistoryMethod('pushState');
        wrapHistoryMethod('replaceState');
        emitRouteChange();
        addWindowListener('load', emitRouteChange);
        addWindowListener('pageshow', emitRouteChange);
        addWindowListener('popstate', emitRouteChange);
        addWindowListener('hashchange', emitRouteChange);
      }

      addWindowListener('message', (event) => {
        const message = event.data || {};

        if (
          message.type === navigationCommandMessageType &&
          message.payload &&
          (message.payload.action === 'back' || message.payload.action === 'forward')
        ) {
          if (message.payload.action === 'back') {
            window.history.back();
          } else {
            window.history.forward();
          }
        }
      });

      addDocumentListener(
        'click',
        (event) => {
          emit('click', event.target, {
            clientX: event.clientX,
            clientY: event.clientY,
            button: event.button,
          });
        },
        true,
      );

      if (includeMouseMove) {
        const flushMouseMove = () => {
          mouseMoveFrame = 0;

          if (!pendingMouseMove) {
            return;
          }

          const nextMouseMove = pendingMouseMove;
          pendingMouseMove = null;

          const signature = [
            nextMouseMove.clientX,
            nextMouseMove.clientY,
            nextMouseMove.target.tagName,
          ].join(':');

          if (signature === lastMouseMoveSignature) {
            return;
          }

          lastMouseMoveSignature = signature;
          emit('mousemove', nextMouseMove.target, {
            clientX: nextMouseMove.clientX,
            clientY: nextMouseMove.clientY,
          });
        };

        addDocumentListener(
          'mousemove',
          (event) => {
            if (!(event.target instanceof Element)) {
              return;
            }

            pendingMouseMove = {
              target: event.target,
              clientX: event.clientX,
              clientY: event.clientY,
            };

            if (!mouseMoveFrame) {
              mouseMoveFrame = window.requestAnimationFrame(flushMouseMove);
            }
          },
          true,
        );
      }

      addDocumentListener(
        'mouseenter',
        (event) => {
          if (event.target !== document.body) {
            emit('hover_start', event.target, {
              clientX: event.clientX,
              clientY: event.clientY,
            });
          }
        },
        true,
      );

      addDocumentListener(
        'mouseleave',
        (event) => {
          if (event.target !== document.body) {
            emit('hover_end', event.target);
          }
        },
        true,
      );

      addDocumentListener(
        'focus',
        (event) => {
          emit('focus', event.target);
        },
        true,
      );

      addDocumentListener(
        'blur',
        (event) => {
          emit('blur', event.target);
        },
        true,
      );

      addDocumentListener(
        'keydown',
        (event) => {
          emit('keydown', event.target, { key: event.key, code: event.code });
        },
        true,
      );

      addDocumentListener(
        'keyup',
        (event) => {
          emit('keyup', event.target, { key: event.key, code: event.code });
        },
        true,
      );

      addDocumentListener(
        'input',
        (event) => {
          const target = event.target;

          if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement
          ) {
            emit('input', target, { value: target.value });
          }
        },
        true,
      );

      addDocumentListener(
        'scroll',
        (event) => {
          if (scrollTicking) {
            return;
          }

          const target = event.target;
          pendingScrollTarget = target;
          scrollTicking = true;

          scrollFrame = window.requestAnimationFrame(() => {
            scrollFrame = 0;
            scrollTicking = false;
            const nextTarget = pendingScrollTarget;
            pendingScrollTarget = null;

            if (
              nextTarget === document ||
              nextTarget === window ||
              nextTarget === document.body ||
              nextTarget === document.documentElement
            ) {
              const scrollElement =
                document.scrollingElement || document.documentElement;
              emit('scroll', document.body, {
                scrollTop: scrollElement.scrollTop,
                scrollLeft: scrollElement.scrollLeft,
                isDocument: true,
              });
            } else if (nextTarget instanceof Element) {
              emit('scroll', nextTarget, {
                scrollTop: nextTarget.scrollTop,
                scrollLeft: nextTarget.scrollLeft,
                isDocument: false,
              });
            }
          });
        },
        true,
      );
    })();
  `;
}
