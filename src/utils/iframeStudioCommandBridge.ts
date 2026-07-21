export const STUDIO_PREVIEW_COMMAND_MESSAGE_TYPE = "NEXT_EDITOR_STUDIO_PREVIEW_COMMAND";
export const STUDIO_PREVIEW_COMMAND_RESPONSE_MESSAGE_TYPE =
  "NEXT_EDITOR_STUDIO_PREVIEW_COMMAND_RESPONSE";

/** A durable author-owned hook inside the preview. CSS/XPath guesses are not accepted. */
export interface StudioPreviewCommandTarget {
  testId: string;
}

export type StudioPreviewCommand =
  | { type: "ping" }
  | { type: "click"; target: StudioPreviewCommandTarget }
  | { type: "input"; target: StudioPreviewCommandTarget; value: string }
  | {
      type: "scroll";
      target?: StudioPreviewCommandTarget;
      top: number;
      left: number;
    }
  | { type: "route"; route: string }
  | { type: "inspect"; target?: StudioPreviewCommandTarget };

export interface StudioPreviewTargetInspection {
  attributes: Record<string, string>;
  tagName: string;
  testId: string;
  text: string;
  value: string | null;
}

export interface StudioPreviewCommandResult {
  command: StudioPreviewCommand["type"];
  route: string;
  scrollLeft: number;
  scrollTop: number;
  target?: StudioPreviewTargetInspection;
}

interface StudioPreviewCommandResponsePayload {
  error?: unknown;
  id?: unknown;
  result?: unknown;
}

let commandRequestId = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTargetInspection(value: unknown): value is StudioPreviewTargetInspection {
  return (
    isRecord(value) &&
    isRecord(value.attributes) &&
    Object.values(value.attributes).every((entry) => typeof entry === "string") &&
    typeof value.tagName === "string" &&
    typeof value.testId === "string" &&
    typeof value.text === "string" &&
    (value.value === null || typeof value.value === "string")
  );
}

function isCommandResult(value: unknown): value is StudioPreviewCommandResult {
  return (
    isRecord(value) &&
    ["ping", "click", "input", "scroll", "route", "inspect"].includes(
      String(value.command),
    ) &&
    typeof value.route === "string" &&
    typeof value.scrollLeft === "number" &&
    Number.isFinite(value.scrollLeft) &&
    typeof value.scrollTop === "number" &&
    Number.isFinite(value.scrollTop) &&
    (value.target === undefined || isTargetInspection(value.target))
  );
}

/**
 * Send one command to the injected cross-origin preview bridge and require its
 * correlated acknowledgement. Cancellation only abandons the acknowledgement;
 * commands themselves are synchronous inside the iframe.
 */
export function requestStudioPreviewCommand(
  iframe: HTMLIFrameElement | null,
  command: StudioPreviewCommand,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<StudioPreviewCommandResult> {
  const targetWindow = iframe?.contentWindow;
  if (!targetWindow) {
    return Promise.reject(new Error("The live preview iframe is not available"));
  }
  if (options.signal.aborted) {
    return Promise.reject(new Error("The preview command was cancelled"));
  }

  const id = `studio-preview-${++commandRequestId}`;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", handleMessage);
      options.signal.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      reject(new Error("The preview command was cancelled"));
    };
    const handleMessage = (event: MessageEvent) => {
      if (
        event.source !== targetWindow ||
        event.data?.type !== STUDIO_PREVIEW_COMMAND_RESPONSE_MESSAGE_TYPE
      ) {
        return;
      }
      const payload = event.data.payload as StudioPreviewCommandResponsePayload | undefined;
      if (!payload || payload.id !== id) {
        return;
      }
      cleanup();
      if (typeof payload.error === "string") {
        reject(new Error(payload.error));
        return;
      }
      if (!isCommandResult(payload.result)) {
        reject(new Error("The preview returned an invalid command acknowledgement"));
        return;
      }
      resolve(payload.result);
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Preview command timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    window.addEventListener("message", handleMessage);
    options.signal.addEventListener("abort", handleAbort, { once: true });
    targetWindow.postMessage(
      { type: STUDIO_PREVIEW_COMMAND_MESSAGE_TYPE, payload: { id, command } },
      "*",
    );
  });
}

/** Raw script injected by WebContainer.setPreviewScript into every HTML response. */
export function createStudioPreviewCommandBridgeScript(setupMarker: string): string {
  return `
    (function() {
      var marker = ${JSON.stringify("__MARKER__")};
      if (window[marker]) return;
      window[marker] = true;

      var requestType = ${JSON.stringify(STUDIO_PREVIEW_COMMAND_MESSAGE_TYPE)};
      var responseType = ${JSON.stringify(STUDIO_PREVIEW_COMMAND_RESPONSE_MESSAGE_TYPE)};

      function route() {
        return (window.location.pathname || '/') + (window.location.search || '') + (window.location.hash || '');
      }

      function findTarget(target) {
        if (!target || typeof target.testId !== 'string' || !target.testId) {
          throw new Error('A non-empty data-testid target is required');
        }
        var elements = document.querySelectorAll('[data-testid]');
        for (var index = 0; index < elements.length; index += 1) {
          if (elements[index].getAttribute('data-testid') === target.testId) {
            return elements[index];
          }
        }
        throw new Error('Preview target data-testid="' + target.testId + '" was not found');
      }

      function inspect(element) {
        if (!element) return undefined;
        var attributes = {};
        Array.from(element.attributes || []).forEach(function(attribute) {
          attributes[attribute.name] = attribute.value;
        });
        var value = null;
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
        ) {
          value = element.value;
        }
        return {
          attributes: attributes,
          tagName: element.tagName.toLowerCase(),
          testId: element.getAttribute('data-testid') || '',
          text: element.textContent || '',
          value: value,
        };
      }

      function setValue(element, value) {
        var prototype =
          element instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : element instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : element instanceof HTMLSelectElement
                ? HTMLSelectElement.prototype
                : null;
        if (!prototype) {
          throw new Error('Preview input target is not an input, textarea, or select');
        }
        var descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (!descriptor || typeof descriptor.set !== 'function') {
          throw new Error('Preview input target has no writable value');
        }
        element.focus();
        descriptor.set.call(element, value);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function result(command, target) {
        var scrollingElement = document.scrollingElement || document.documentElement;
        return {
          command: command.type,
          route: route(),
          scrollLeft: scrollingElement ? scrollingElement.scrollLeft : 0,
          scrollTop: scrollingElement ? scrollingElement.scrollTop : 0,
          target: inspect(target),
        };
      }

      function acknowledge(id, response) {
        try {
          window.parent.postMessage(
            { type: responseType, payload: Object.assign({ id: id }, response) },
            '*',
          );
        } catch {}
      }

      async function execute(command) {
        if (!command || typeof command.type !== 'string') {
          throw new Error('Invalid preview command');
        }
        var target;
        if (command.type === 'ping') {
          // The acknowledgement itself proves the iframe and injected bridge are ready.
        } else if (command.type === 'click') {
          target = findTarget(command.target);
          if (!(target instanceof HTMLElement)) {
            throw new Error('Preview click target is not an HTML element');
          }
          target.focus();
          target.click();
        } else if (command.type === 'input') {
          target = findTarget(command.target);
          setValue(target, String(command.value));
        } else if (command.type === 'scroll') {
          if (command.target) {
            target = findTarget(command.target);
            target.scrollTo({ top: Number(command.top), left: Number(command.left), behavior: 'instant' });
          } else {
            window.scrollTo({ top: Number(command.top), left: Number(command.left), behavior: 'instant' });
          }
        } else if (command.type === 'route') {
          if (typeof command.route !== 'string' || command.route.charAt(0) !== '/') {
            throw new Error('Preview routes must start with /');
          }
          window.history.pushState(null, '', command.route);
          window.dispatchEvent(new PopStateEvent('popstate'));
        } else if (command.type === 'inspect') {
          target = command.target ? findTarget(command.target) : undefined;
        } else {
          throw new Error('Unsupported preview command "' + command.type + '"');
        }

        await Promise.resolve();
        await new Promise(function(resolve) { window.requestAnimationFrame(function() { resolve(); }); });
        return result(command, target);
      }

      window.addEventListener('message', function(event) {
        if (event.source !== window.parent || !event.data || event.data.type !== requestType) return;
        var payload = event.data.payload;
        if (!payload || typeof payload.id !== 'string') return;
        execute(payload.command).then(
          function(value) { acknowledge(payload.id, { result: value }); },
          function(error) {
            acknowledge(payload.id, { error: error instanceof Error ? error.message : String(error) });
          },
        );
      });
    })();
  `.replace("__MARKER__", setupMarker);
}
