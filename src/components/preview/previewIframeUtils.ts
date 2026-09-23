export const RUNTIME_SNAPSHOT_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_SNAPSHOT";
export const RUNTIME_SNAPSHOT_REQUEST_MESSAGE_TYPE = "NEXT_EDITOR_REQUEST_RUNTIME_SNAPSHOT";

export interface PreviewScrollPosition {
  scrollTop: number;
  scrollLeft: number;
}

export function createReplayableRuntimePreview(
  iframe: HTMLIFrameElement,
  baseUrl: string,
): string | null {
  try {
    const iframeDocument = iframe.contentDocument || iframe.contentWindow?.document;

    if (!iframeDocument?.documentElement) {
      return null;
    }

    return createReplayableRuntimePreviewFromHtml(
      iframeDocument.documentElement.outerHTML,
      baseUrl,
    );
  } catch {
    return null;
  }
}

// Produces a script-free, base-anchored full-snapshot HTML used for the runtime
// snapshot fallback / float capture. Scripts are dropped (replay is visual-only)
// and a <base> is prepended so relative asset URLs resolve against the runtime.
export function createReplayableRuntimePreviewFromHtml(
  htmlContent: string,
  baseUrl: string,
): string | null {
  try {
    const parser = new DOMParser();
    const iframeDocument = parser.parseFromString(htmlContent, "text/html");

    if (!iframeDocument?.documentElement) {
      return null;
    }

    const html = iframeDocument.documentElement.cloneNode(true);

    if (!(html instanceof HTMLElement)) {
      return null;
    }

    html.querySelectorAll("script").forEach((script) => {
      script.remove();
    });

    const head = html.querySelector("head");

    if (head) {
      head.querySelector("base")?.remove();

      const base = head.ownerDocument.createElement("base");
      base.setAttribute("href", baseUrl);
      head.prepend(base);
    }

    return `<!doctype html>\n${html.outerHTML}`;
  } catch {
    return null;
  }
}
