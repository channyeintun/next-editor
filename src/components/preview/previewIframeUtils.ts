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
// Unknown script type the browser refuses to execute. Used to neutralize
// scripts both when deserializing inserted nodes and when building the patch
// replay seed, so script elements stay in the tree (preserving child indices
// and marker ids) without ever running.
const INERT_SCRIPT_TYPE = "application/x-next-editor-inert-script";

// Nodes resolved inside the preview iframe belong to the iframe's realm, so
// `instanceof Element` (this module's realm) is false for them. Compare the
// realm-agnostic nodeType instead.
function isElement(node: Node | null | undefined): node is Element {
  return node?.nodeType === ELEMENT_NODE;
}

// Attributes that carry URLs we must sanitize for `javascript:` payloads.
const REPLAY_URL_ATTRIBUTE_NAMES = new Set(["href", "xlink:href", "src", "action", "formaction"]);

// Replay runs in a same-origin iframe with `allow-scripts`, so recorded markup
// must not carry executable hooks. `<script>` is already inert via type, but
// inline event handlers (onclick/onerror/onload/...) and `javascript:` URLs
// would still run on load or interaction. Strip them in place — replay is
// visual-only, so neutralizing them changes nothing the viewer should see.
function neutralizeReplayElement(element: Element) {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();

    if (name.startsWith("on")) {
      element.removeAttribute(attribute.name);
      continue;
    }

    if (REPLAY_URL_ATTRIBUTE_NAMES.has(name) && /^\s*javascript:/i.test(attribute.value)) {
      element.removeAttribute(attribute.name);
    }
  }

  if (element.tagName.toLowerCase() === "script") {
    element.setAttribute("type", INERT_SCRIPT_TYPE);
    element.removeAttribute("src");
  }
}

function neutralizeReplaySubtree(root: Element) {
  neutralizeReplayElement(root);
  root.querySelectorAll("*").forEach((element) => neutralizeReplayElement(element));
}

export interface PreviewDomPatchApplyResult {
  // `false` only when the iframe document itself is unusable (missing or
  // cross-origin). Individual op failures do NOT make a batch fail: they are
  // counted in `failedOps` and skipped, so one unresolved node can never freeze
  // playback. The plan's "fail soft, do not break playback" contract.
  ok: boolean;
  appliedOps: number;
  failedOps: number;
  error?: string;
  firstFailedOpIndex?: number;
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

// Per-document cache of marker id -> element, so repeated ref lookups across a
// long replay are O(1) instead of an O(n) `querySelector` scan each time. Marker
// ids are monotonic and never reused within a document session, so a cached node
// is always correct as long as it is still connected and still carries the id.
export type PreviewReplayNodeIndex = Map<string, Element>;

function escapeMarkerId(id: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id;
}

function resolveMarkerElement(
  doc: Document,
  id: string,
  nodeIndex?: PreviewReplayNodeIndex,
): Element | null {
  const cached = nodeIndex?.get(id);
  if (
    cached &&
    cached.isConnected &&
    cached.getAttribute(PREVIEW_REPLAY_NODE_ID_ATTRIBUTE) === id
  ) {
    return cached;
  }

  const element = doc.querySelector(
    `[${PREVIEW_REPLAY_NODE_ID_ATTRIBUTE}="${escapeMarkerId(id)}"]`,
  );

  if (nodeIndex) {
    if (element) {
      nodeIndex.set(id, element);
    } else {
      nodeIndex.delete(id);
    }
  }

  return element;
}

function findNodeByPreviewRef(
  doc: Document,
  ref: PreviewNodeRef,
  nodeIndex?: PreviewReplayNodeIndex,
): Node | null {
  // Element refs carry a stable marker id. Resolve strictly by it: a miss means
  // the replay DOM has drifted from the recording, which must surface as a
  // desync (handled by the caller's recovery) rather than silently falling back
  // to a `documentElement` path that encodes the recording-time structure.
  if (ref.id) {
    return resolveMarkerElement(doc, ref.id, nodeIndex);
  }

  let current: Node | null = doc.documentElement;

  if (ref.anchorId) {
    current = resolveMarkerElement(doc, ref.anchorId, nodeIndex);

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
    element.setAttribute("type", INERT_SCRIPT_TYPE);
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
    neutralizeReplaySubtree(wrapper);
    return wrapper;
  }

  const template = ownerDocument.createElement("template");
  template.innerHTML = html.trim();

  const node = template.content.firstChild;
  if (isElement(node)) {
    neutralizeReplaySubtree(node);
  }

  return node;
}

function applyPreviewDomPatchOp(
  doc: Document,
  op: PreviewDomPatchOp,
  nodeIndex?: PreviewReplayNodeIndex,
): { ok: boolean; error?: string } {
  if (op.op === "insert_node") {
    const parent = findNodeByPreviewRef(doc, op.parent, nodeIndex);

    if (!parent) {
      return { ok: false, error: "Missing insert parent" };
    }

    const nextSibling = parent.childNodes[op.index] ?? null;
    const newNode = deserializePreviewNode(op.node, doc);
    if (isElement(newNode)) {
      neutralizeReplaySubtree(newNode);
    }
    parent.insertBefore(newNode, nextSibling);
    return { ok: true };
  }

  const target = findNodeByPreviewRef(doc, op.target, nodeIndex);

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
      const parent = findNodeByPreviewRef(doc, op.parent, nodeIndex);

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

      // Reconcile in place with the realm-safe (importNode-based) patcher rather
      // than morphdom: the replacement node and target both live in the iframe
      // realm, but morphdom's internal helpers reach for the parent-realm
      // `document`, which corrupts replay. The replacement HTML carries marker
      // ids, so reconciled children stay resolvable by later ops.
      if (op.mode === "children") {
        patchChildNodes(target, replacementNode, doc);
      } else {
        patchNode(target, replacementNode, doc);
      }
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
  nodeIndex?: PreviewReplayNodeIndex,
): PreviewDomPatchApplyResult {
  let iframeDocument: Document | null | undefined;
  try {
    iframeDocument = iframe.contentDocument || iframe.contentWindow?.document;
  } catch {
    iframeDocument = null;
  }

  if (!iframeDocument?.documentElement) {
    return {
      ok: false,
      appliedOps: 0,
      failedOps: batch.ops.length,
      error: "Missing iframe document",
    };
  }

  let appliedOps = 0;
  let failedOps = 0;
  let firstError: string | undefined;
  let firstFailedOpIndex: number | undefined;

  // Apply every op best-effort. A single op that cannot resolve its node (or
  // throws) is skipped rather than aborting the batch, so the rest of this and
  // every later batch still apply and the preview keeps tracking.
  for (let index = 0; index < batch.ops.length; index++) {
    let result: { ok: boolean; error?: string };
    try {
      result = applyPreviewDomPatchOp(iframeDocument, batch.ops[index], nodeIndex);
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown patch apply error",
      };
    }

    if (result.ok) {
      appliedOps += 1;
      continue;
    }

    failedOps += 1;
    if (firstError === undefined) {
      firstError = result.error;
      firstFailedOpIndex = index;
    }
  }

  return { ok: true, appliedOps, failedOps, error: firstError, firstFailedOpIndex };
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

// Prepares a recorded runtime seed for patch replay. Unlike
// `createReplayableRuntimePreviewFromHtml` (used for full-snapshot replacement,
// where dropping scripts is fine), this MUST preserve the exact node structure
// the recorder measured its patch refs against: scripts are neutralized in
// place instead of removed, and the resource `<base>` is added without shifting
// any existing child index. Marker ids are preserved by `cloneNode`.
export function createPatchReplaySeedFromHtml(htmlContent: string, baseUrl: string): string | null {
  try {
    const parser = new DOMParser();
    const parsedDocument = parser.parseFromString(htmlContent, "text/html");

    if (!parsedDocument?.documentElement) {
      return null;
    }

    const html = parsedDocument.documentElement.cloneNode(true);

    if (!(html instanceof HTMLElement)) {
      return null;
    }

    // Keep every element (so child indices and marker ids stay valid), but
    // strip everything executable: inert scripts, inline handlers, javascript:
    // URLs.
    neutralizeReplaySubtree(html);

    const head = html.querySelector("head");

    if (head) {
      const existingBase = head.querySelector("base");

      if (existingBase) {
        // Update in place: same element, same index, no structural change.
        existingBase.setAttribute("href", baseUrl);
      } else {
        // Append as the last head child so existing children keep indices.
        const base = head.ownerDocument.createElement("base");
        base.setAttribute("href", baseUrl);
        head.append(base);
      }
    }

    return `<!doctype html>\n${html.outerHTML}`;
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
