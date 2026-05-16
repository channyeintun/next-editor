export const IFRAME_INTERACTION_MESSAGE_TYPE = "IFRAME_INTERACTION";

export function createIframeInteractionCaptureScript(
  setupMarker: string,
): string {
  return `
    (function() {
      const marker = ${JSON.stringify(setupMarker)};
      if (window[marker]) return;
      window[marker] = true;

      const messageType = ${JSON.stringify(IFRAME_INTERACTION_MESSAGE_TYPE)};

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
