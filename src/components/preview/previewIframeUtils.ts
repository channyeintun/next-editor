export const RUNTIME_SNAPSHOT_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_SNAPSHOT";

export interface PreviewScrollPosition {
  scrollTop: number;
  scrollLeft: number;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

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

function syncElementAttributes(currentElement: Element, nextElement: Element) {
  Array.from(currentElement.attributes).forEach((attribute) => {
    if (!nextElement.hasAttribute(attribute.name)) {
      currentElement.removeAttribute(attribute.name);
    }
  });

  Array.from(nextElement.attributes).forEach((attribute) => {
    if (currentElement.getAttribute(attribute.name) !== attribute.value) {
      currentElement.setAttribute(attribute.name, attribute.value);
    }
  });
}

function syncElementState(currentElement: Element, nextElement: Element) {
  const tagName = currentElement.tagName.toLowerCase();

  if (tagName === "input") {
    const currentInput = currentElement as HTMLInputElement;
    const nextInput = nextElement as HTMLInputElement;

    currentInput.value = nextInput.value;
    currentInput.checked = nextInput.checked;
    return;
  }

  if (tagName === "textarea") {
    (currentElement as HTMLTextAreaElement).value = (
      nextElement as HTMLTextAreaElement
    ).value;
    return;
  }

  if (tagName === "option") {
    (currentElement as HTMLOptionElement).selected = (
      nextElement as HTMLOptionElement
    ).selected;
  }
}

function canPatchNode(currentNode: Node, nextNode: Node): boolean {
  if (currentNode.nodeType !== nextNode.nodeType) {
    return false;
  }

  if (currentNode.nodeType !== ELEMENT_NODE) {
    return true;
  }

  return (
    (currentNode as Element).tagName.toLowerCase() ===
    (nextNode as Element).tagName.toLowerCase()
  );
}

function patchNode(
  currentNode: Node,
  nextNode: Node,
  ownerDocument: Document,
) {
  if (!canPatchNode(currentNode, nextNode)) {
    currentNode.parentNode?.replaceChild(
      ownerDocument.importNode(nextNode, true),
      currentNode,
    );
    return;
  }

  if (
    currentNode.nodeType === TEXT_NODE ||
    currentNode.nodeType === COMMENT_NODE
  ) {
    if (currentNode.nodeValue !== nextNode.nodeValue) {
      currentNode.nodeValue = nextNode.nodeValue;
    }
    return;
  }

  if (currentNode.nodeType !== ELEMENT_NODE) {
    return;
  }

  const currentElement = currentNode as Element;
  const nextElement = nextNode as Element;

  syncElementAttributes(currentElement, nextElement);
  syncElementState(currentElement, nextElement);
  patchChildNodes(currentElement, nextElement, ownerDocument);
}

function patchChildNodes(
  currentParent: Node,
  nextParent: Node,
  ownerDocument: Document,
) {
  let index = 0;

  while (index < nextParent.childNodes.length) {
    const nextChild = nextParent.childNodes[index];
    const currentChild = currentParent.childNodes[index];

    if (!currentChild) {
      currentParent.appendChild(ownerDocument.importNode(nextChild, true));
      index++;
      continue;
    }

    patchNode(currentChild, nextChild, ownerDocument);
    index++;
  }

  while (currentParent.childNodes.length > nextParent.childNodes.length) {
    const extraChild = currentParent.childNodes[nextParent.childNodes.length];
    currentParent.removeChild(extraChild);
  }
}

function patchDocumentSection(
  currentSection: Element | null,
  nextSection: Element | null,
  ownerDocument: Document,
): boolean {
  if (
    !currentSection ||
    !nextSection ||
    !canPatchNode(currentSection, nextSection)
  ) {
    return false;
  }

  patchNode(currentSection, nextSection, ownerDocument);
  return true;
}

export function patchIframeContentFromHtml(
  iframe: HTMLIFrameElement,
  htmlContent: string,
): boolean {
  try {
    const iframeDocument =
      iframe.contentDocument || iframe.contentWindow?.document;

    if (!iframeDocument?.documentElement) {
      return false;
    }

    const nextDocument = new DOMParser().parseFromString(
      htmlContent,
      "text/html",
    );

    if (
      !nextDocument.documentElement ||
      !canPatchNode(
        iframeDocument.documentElement,
        nextDocument.documentElement,
      )
    ) {
      return false;
    }

    syncElementAttributes(
      iframeDocument.documentElement,
      nextDocument.documentElement,
    );

    return (
      patchDocumentSection(
        iframeDocument.head,
        nextDocument.head,
        iframeDocument,
      ) &&
      patchDocumentSection(
        iframeDocument.body,
        nextDocument.body,
        iframeDocument,
      )
    );
  } catch {
    return false;
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
