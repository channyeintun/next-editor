export const RUNTIME_SNAPSHOT_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_SNAPSHOT";

export interface PreviewScrollPosition {
  scrollTop: number;
  scrollLeft: number;
}

export function getElementByXPath(
  doc: Document,
  xpath: string,
): Element | null {
  try {
    const result = doc.evaluate(
      xpath,
      doc,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    );
    return result.singleNodeValue as Element | null;
  } catch {
    return null;
  }
}

export function createReplayableRuntimePreview(
  iframe: HTMLIFrameElement,
  baseUrl: string,
): string | null {
  try {
    const iframeDocument =
      iframe.contentDocument || iframe.contentWindow?.document;

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
