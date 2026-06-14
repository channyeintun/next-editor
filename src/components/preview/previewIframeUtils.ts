import morphdom from "morphdom";
import type {
  PreviewDomPatchBatch,
  PreviewDomPatchOp,
  PreviewInitialDocument,
  PreviewNodeRef,
  SerializedPreviewNode,
} from "../../types/slides";

export const RUNTIME_SNAPSHOT_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_SNAPSHOT";
export const RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_INITIAL_DOCUMENT";
export const RUNTIME_PATCH_BATCH_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_PATCH_BATCH";

export interface PreviewScrollPosition {
  scrollTop: number;
  scrollLeft: number;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const PREVIEW_REPLAY_NODE_ID_ATTRIBUTE = "data-next-editor-preview-node-id";

// Nodes resolved inside the preview iframe belong to the iframe's realm, so
// `instanceof Element` (this module's realm) is false for them. Compare the
// realm-agnostic nodeType instead.
function isElement(node: Node | null | undefined): node is Element {
  return node?.nodeType === ELEMENT_NODE;
}

export interface PreviewDomPatchApplyResult {
  ok: boolean;
  appliedOps: number;
  error?: string;
}

export function getElementByXPath(doc: Document, xpath: string): Element | null {
  try {
    const result = doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
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
    (currentElement as HTMLTextAreaElement).value = (nextElement as HTMLTextAreaElement).value;
    return;
  }

  if (tagName === "option") {
    (currentElement as HTMLOptionElement).selected = (nextElement as HTMLOptionElement).selected;
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
    (currentNode as Element).tagName.toLowerCase() === (nextNode as Element).tagName.toLowerCase()
  );
}

function patchNode(currentNode: Node, nextNode: Node, ownerDocument: Document) {
  if (!canPatchNode(currentNode, nextNode)) {
    currentNode.parentNode?.replaceChild(ownerDocument.importNode(nextNode, true), currentNode);
    return;
  }

  if (currentNode.nodeType === TEXT_NODE || currentNode.nodeType === COMMENT_NODE) {
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

function patchChildNodes(currentParent: Node, nextParent: Node, ownerDocument: Document) {
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
  if (!currentSection || !nextSection || !canPatchNode(currentSection, nextSection)) {
    return false;
  }

  patchNode(currentSection, nextSection, ownerDocument);
  return true;
}

function replaceDocumentElement(currentDocument: Document, nextDocument: Document): boolean {
  const nextDocumentElement = nextDocument.documentElement;

  if (!nextDocumentElement) {
    return false;
  }

  const importedDocumentElement = currentDocument.importNode(nextDocumentElement, true);

  if (currentDocument.documentElement) {
    currentDocument.replaceChild(importedDocumentElement, currentDocument.documentElement);
  } else {
    currentDocument.appendChild(importedDocumentElement);
  }

  return true;
}

function findNodeByPreviewRef(doc: Document, ref: PreviewNodeRef): Node | null {
  if (ref.id) {
    const markerElement = doc.querySelector(`[${PREVIEW_REPLAY_NODE_ID_ATTRIBUTE}="${ref.id}"]`);

    if (markerElement) {
      return markerElement;
    }
  }

  let current: Node | null = doc.documentElement;

  if (ref.anchorId) {
    current = doc.querySelector(`[${PREVIEW_REPLAY_NODE_ID_ATTRIBUTE}="${ref.anchorId}"]`);

    if (!current) {
      return null;
    }
  }

  for (const index of ref.path) {
    current = current?.childNodes[index] ?? null;

    if (!current) {
      return null;
    }
  }

  return current;
}

function deserializePreviewNode(
  serializedNode: SerializedPreviewNode,
  ownerDocument: Document,
): Node {
  if (serializedNode.kind === "text") {
    return ownerDocument.createTextNode(serializedNode.text ?? "");
  }

  if (serializedNode.kind === "comment") {
    return ownerDocument.createComment(serializedNode.text ?? "");
  }

  if (serializedNode.kind === "doctype") {
    return ownerDocument.createComment(serializedNode.text ?? "doctype");
  }

  const tagName = serializedNode.tagName ?? "div";
  const element = serializedNode.namespaceURI
    ? ownerDocument.createElementNS(serializedNode.namespaceURI, tagName)
    : ownerDocument.createElement(tagName);

  if (tagName.toLowerCase() === "script") {
    element.setAttribute("type", "application/x-next-editor-inert-script");
  }

  for (const [name, value] of serializedNode.attributes ?? []) {
    if (tagName.toLowerCase() === "script" && name.toLowerCase() === "type") {
      continue;
    }

    element.setAttribute(name, value);
  }

  for (const child of serializedNode.children ?? []) {
    element.appendChild(deserializePreviewNode(child, ownerDocument));
  }

  return element;
}

function setElementProperty(
  target: Node,
  name: "value" | "checked" | "selected",
  value: string | boolean,
) {
  if (!isElement(target)) {
    return false;
  }

  if (name === "value" && "value" in target && typeof value === "string") {
    target.value = value;
    return true;
  }

  if (name === "checked" && "checked" in target && typeof value === "boolean") {
    target.checked = value;
    return true;
  }

  if (name === "selected" && "selected" in target && typeof value === "boolean") {
    target.selected = value;
    return true;
  }

  return false;
}

function createMorphdomOptions(mode: "children" | "node") {
  return {
    childrenOnly: mode === "children",
    getNodeKey(node: Node) {
      if (!isElement(node)) {
        return undefined;
      }

      return node.getAttribute(PREVIEW_REPLAY_NODE_ID_ATTRIBUTE) || node.id || undefined;
    },
    onBeforeElUpdated(fromEl: HTMLElement, toEl: HTMLElement) {
      syncElementState(fromEl, toEl);
      return true;
    },
  };
}

function createSubtreeReplacementNode(
  target: Node,
  html: string,
  mode: "children" | "node",
  ownerDocument: Document,
): Node | null {
  if (mode === "children") {
    if (!isElement(target)) {
      return null;
    }

    const wrapper = target.cloneNode(false) as Element;
    wrapper.innerHTML = html;
    return wrapper;
  }

  const template = ownerDocument.createElement("template");
  template.innerHTML = html.trim();

  return template.content.firstChild;
}

function applyPreviewDomPatchOp(
  doc: Document,
  op: PreviewDomPatchOp,
): { ok: boolean; error?: string } {
  if (op.op === "insert_node") {
    const parent = findNodeByPreviewRef(doc, op.parent);

    if (!parent) {
      return { ok: false, error: "Missing insert parent" };
    }

    const nextSibling = parent.childNodes[op.index] ?? null;
    parent.insertBefore(deserializePreviewNode(op.node, doc), nextSibling);
    return { ok: true };
  }

  const target = findNodeByPreviewRef(doc, op.target);

  if (!target) {
    return { ok: false, error: "Missing target node" };
  }

  switch (op.op) {
    case "set_text":
      target.nodeValue = op.text;
      return { ok: true };
    case "set_attribute":
      if (!isElement(target)) {
        return { ok: false, error: "Attribute target is not an element" };
      }
      if (op.namespaceURI) {
        target.setAttributeNS(op.namespaceURI, op.name, op.value);
      } else {
        target.setAttribute(op.name, op.value);
      }
      return { ok: true };
    case "remove_attribute":
      if (!isElement(target)) {
        return { ok: false, error: "Attribute target is not an element" };
      }
      if (op.namespaceURI) {
        target.removeAttributeNS(op.namespaceURI, op.name);
      } else {
        target.removeAttribute(op.name);
      }
      return { ok: true };
    case "remove_node":
      if (!target.parentNode) {
        return { ok: false, error: "Target node has no parent" };
      }
      target.parentNode.removeChild(target);
      return { ok: true };
    case "move_node": {
      const parent = findNodeByPreviewRef(doc, op.parent);

      if (!parent) {
        return { ok: false, error: "Missing move parent" };
      }

      const nextSibling = parent.childNodes[op.index] ?? null;
      parent.insertBefore(target, nextSibling);
      return { ok: true };
    }
    case "replace_subtree": {
      const replacementNode = createSubtreeReplacementNode(target, op.html, op.mode, doc);

      if (!replacementNode) {
        return { ok: false, error: "Invalid subtree replacement" };
      }

      morphdom(target, replacementNode, createMorphdomOptions(op.mode));
      return { ok: true };
    }
    case "set_property":
      return setElementProperty(target, op.name, op.value)
        ? { ok: true }
        : { ok: false, error: "Unable to set element property" };
    default:
      return { ok: false, error: "Unsupported patch operation" };
  }
}

export function applyPreviewInitialDocumentToIframe(
  iframe: HTMLIFrameElement,
  initialDocument: PreviewInitialDocument,
): boolean {
  return patchIframeContentFromHtml(iframe, initialDocument.html);
}

export function applyPreviewDomPatchBatchToIframe(
  iframe: HTMLIFrameElement,
  batch: PreviewDomPatchBatch,
): PreviewDomPatchApplyResult {
  try {
    const iframeDocument = iframe.contentDocument || iframe.contentWindow?.document;

    if (!iframeDocument?.documentElement) {
      return { ok: false, appliedOps: 0, error: "Missing iframe document" };
    }

    for (let index = 0; index < batch.ops.length; index++) {
      const result = applyPreviewDomPatchOp(iframeDocument, batch.ops[index]);

      if (!result.ok) {
        return {
          ok: false,
          appliedOps: index,
          error: result.error,
        };
      }
    }

    return { ok: true, appliedOps: batch.ops.length };
  } catch (error) {
    return {
      ok: false,
      appliedOps: 0,
      error: error instanceof Error ? error.message : "Unknown patch apply error",
    };
  }
}

export function patchIframeContentFromHtml(
  iframe: HTMLIFrameElement,
  htmlContent: string,
): boolean {
  try {
    const iframeDocument = iframe.contentDocument || iframe.contentWindow?.document;

    if (!iframeDocument) {
      return false;
    }

    const nextDocument = new DOMParser().parseFromString(htmlContent, "text/html");

    if (!nextDocument.documentElement) {
      return false;
    }

    if (
      !iframeDocument.documentElement ||
      !canPatchNode(iframeDocument.documentElement, nextDocument.documentElement)
    ) {
      return replaceDocumentElement(iframeDocument, nextDocument);
    }

    syncElementAttributes(iframeDocument.documentElement, nextDocument.documentElement);

    const didPatchSections =
      patchDocumentSection(iframeDocument.head, nextDocument.head, iframeDocument) &&
      patchDocumentSection(iframeDocument.body, nextDocument.body, iframeDocument);

    return didPatchSections || replaceDocumentElement(iframeDocument, nextDocument);
  } catch {
    return false;
  }
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
