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
      if (window[marker]) return;
      window[marker] = true;

      const messageType = ${JSON.stringify(IFRAME_INTERACTION_MESSAGE_TYPE)};
      const navigationCommandMessageType = ${JSON.stringify(IFRAME_NAVIGATION_COMMAND_MESSAGE_TYPE)};
      const includeMouseMove = ${JSON.stringify(includeMouseMove)};
      const includeRouteChange = ${JSON.stringify(includeRouteChange)};

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

          window.history[methodName] = function() {
            const result = originalMethod.apply(this, arguments);
            emitRouteChange();
            return result;
          };
        };

        wrapHistoryMethod('pushState');
        wrapHistoryMethod('replaceState');
        emitRouteChange();
        window.addEventListener('load', emitRouteChange);
        window.addEventListener('pageshow', emitRouteChange);
        window.addEventListener('popstate', emitRouteChange);
        window.addEventListener('hashchange', emitRouteChange);
      }

      window.addEventListener('message', (event) => {
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

      document.addEventListener(
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
        let pendingMouseMove = null;
        let mouseMoveFrame = 0;
        let lastMouseMoveSignature = '';

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

        document.addEventListener(
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

      document.addEventListener(
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

      document.addEventListener(
        'mouseleave',
        (event) => {
          if (event.target !== document.body) {
            emit('hover_end', event.target);
          }
        },
        true,
      );

      document.addEventListener(
        'focus',
        (event) => {
          emit('focus', event.target);
        },
        true,
      );

      document.addEventListener(
        'blur',
        (event) => {
          emit('blur', event.target);
        },
        true,
      );

      document.addEventListener(
        'keydown',
        (event) => {
          emit('keydown', event.target, { key: event.key, code: event.code });
        },
        true,
      );

      document.addEventListener(
        'keyup',
        (event) => {
          emit('keyup', event.target, { key: event.key, code: event.code });
        },
        true,
      );

      document.addEventListener(
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

      let scrollTicking = false;
      document.addEventListener(
        'scroll',
        (event) => {
          if (scrollTicking) {
            return;
          }

          const target = event.target;
          scrollTicking = true;

          window.requestAnimationFrame(() => {
            if (
              target === document ||
              target === window ||
              target === document.body ||
              target === document.documentElement
            ) {
              const scrollElement =
                document.scrollingElement || document.documentElement;
              emit('scroll', document.body, {
                scrollTop: scrollElement.scrollTop,
                scrollLeft: scrollElement.scrollLeft,
                isDocument: true,
              });
            } else if (target instanceof Element) {
              emit('scroll', target, {
                scrollTop: target.scrollTop,
                scrollLeft: target.scrollLeft,
                isDocument: false,
              });
            }

            scrollTicking = false;
          });
        },
        true,
      );
    })();
  `;
}
