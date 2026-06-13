export const IFRAME_CONSOLE_MESSAGE_TYPE = "NEXT_EDITOR_IFRAME_CONSOLE";

export const IFRAME_CONSOLE_METHODS = ["debug", "error", "info", "log", "warn"] as const;

export type IframeConsoleMethod = (typeof IFRAME_CONSOLE_METHODS)[number];

export interface IframeConsoleMessagePayload {
  args: string[];
  method: IframeConsoleMethod;
  pathname: string;
}

export function isIframeConsoleMethod(value: unknown): value is IframeConsoleMethod {
  return IFRAME_CONSOLE_METHODS.includes(value as IframeConsoleMethod);
}

export function createIframeConsoleBridgeScript(setupMarker: string): string {
  return `
    (function() {
      const marker = ${JSON.stringify(setupMarker)};
      if (window[marker]) return;
      window[marker] = true;

      const messageType = ${JSON.stringify(IFRAME_CONSOLE_MESSAGE_TYPE)};
      const methods = ${JSON.stringify(IFRAME_CONSOLE_METHODS)};
      const consoleObject = window.console;

      if (!consoleObject) {
        return;
      }

      function stringifyArg(value) {
        if (typeof value === 'string') {
          return value;
        }

        if (value instanceof Error) {
          return value.stack || value.message || String(value);
        }

        if (
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          typeof value === 'bigint' ||
          typeof value === 'symbol' ||
          value === null ||
          value === undefined
        ) {
          return String(value);
        }

        try {
          const serialized = JSON.stringify(value);
          return serialized === undefined ? String(value) : serialized;
        } catch {
          try {
            return Object.prototype.toString.call(value);
          } catch {
            return '[unserializable console value]';
          }
        }
      }

      function getPathname() {
        try {
          return (
            window.location.pathname ||
            '/'
          ) + (window.location.search || '') + (window.location.hash || '');
        } catch {
          return '';
        }
      }

      function postConsoleMessage(method, args) {
        try {
          window.parent.postMessage(
            {
              type: messageType,
              payload: {
                method,
                args: Array.from(args, stringifyArg),
                pathname: getPathname(),
              },
            },
            '*',
          );
        } catch {}
      }

      methods.forEach((method) => {
        const original = consoleObject[method];

        if (typeof original !== 'function') {
          return;
        }

        consoleObject[method] = function() {
          postConsoleMessage(method, arguments);
          return original.apply(consoleObject, arguments);
        };
      });
    })();
  `;
}
