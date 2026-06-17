import { describe, expect, it } from "vite-plus/test";
import { JSDOM } from "jsdom";
import type { DOMWindow } from "jsdom";
import { createRuntimePatchRecorderScript } from "../../contexts/webContainerRuntimeSupport";
import {
  applyPreviewDomPatchBatchToIframe,
  applyPreviewInitialDocumentToIframe,
  createPatchReplaySeedFromHtml,
  RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE,
  RUNTIME_PATCH_BATCH_MESSAGE_TYPE,
} from "./previewIframeUtils";
import type {
  PreviewDomPatchBatch,
  PreviewDomPatchOp,
  PreviewInitialDocument,
  PreviewInsertNodeOp,
  PreviewSetTextOp,
} from "../../types/slides";

// Mirrors the private marker contract shared by the recorder and the replay
// engine. Kept local on purpose: the test fails loudly if either side renames it.
const PREVIEW_REPLAY_NODE_ID_ATTRIBUTE = "data-next-editor-preview-node-id";

// Base the production bridge injects into every seed for resource resolution.
const REPLAY_BASE_URL = "https://preview.example/";

// Mirrors a real node.js runtime page: an empty mount point plus a module
// script in <body>. These are exactly the structures the production seed
// transform must preserve (script kept + neutralized, base added without
// shifting indices) so recorded refs still resolve on replay.
const SEED_HTML =
  "<!DOCTYPE html><html><head><title>App</title></head>" +
  '<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>';

interface RecorderMessage {
  type: string;
  payload: PreviewInitialDocument | PreviewDomPatchBatch;
}

interface Evaluable {
  eval(code: string): unknown;
}

interface RecordedScenario {
  seed: PreviewInitialDocument;
  batches: PreviewDomPatchBatch[];
  ops: PreviewDomPatchOp[];
  liveHtml: string;
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function waitForLoad(targetWindow: DOMWindow): Promise<void> {
  return new Promise((resolve) => {
    if (targetWindow.document.readyState === "complete") {
      resolve();
      return;
    }

    targetWindow.addEventListener("load", () => resolve(), { once: true });
  });
}

function normalizeHtml(html: string): string {
  return (
    html
      .replaceAll(/\s+data-next-editor-preview-node-id="[^"]*"/g, "")
      // Script execution attributes differ between the live (executable) DOM and
      // the inert replay seed; the structure they live in is what matters here.
      .replaceAll(/(<script\b[^>]*?)\s+type="[^"]*"/g, "$1")
      .replaceAll(/(<script\b[^>]*?)\s+src="[^"]*"/g, "$1")
      // The seed transform injects a resource <base> the live DOM never had.
      .replaceAll(/<base\b[^>]*>/g, "")
      .replaceAll(/>\s+</g, "><")
      .trim()
  );
}

// Drives the genuine production recorder over a realistic mutation sequence and
// returns the seed document plus the patch batches it emitted, exactly as the
// runtime preview would post them across the iframe boundary.
async function recordScenario(): Promise<RecordedScenario> {
  const dom = new JSDOM(SEED_HTML, { runScripts: "outside-only" });
  const recorderWindow = dom.window;
  const recorderDocument = recorderWindow.document;

  const messages: RecorderMessage[] = [];
  recorderWindow.postMessage = ((message: RecorderMessage) => {
    messages.push(message);
  }) as unknown as typeof recorderWindow.postMessage;

  // The recorder coalesces mutations behind requestAnimationFrame. Capture the
  // scheduled callbacks so each step can be flushed into its own patch batch.
  const frameCallbacks: FrameRequestCallback[] = [];
  recorderWindow.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  };
  recorderWindow.cancelAnimationFrame = (): void => {};

  const flush = async (): Promise<void> => {
    await nextMacrotask();
    const callbacks = frameCallbacks.splice(0, frameCallbacks.length);
    for (const callback of callbacks) {
      callback(0);
    }
  };

  await waitForLoad(recorderWindow);

  // readyState is "complete", so the recorder seeds the initial document
  // immediately and starts observing — the same path used in production.
  (recorderWindow as unknown as Evaluable).eval(createRuntimePatchRecorderScript());

  // Step 1: a whitespace text node inserted between <head> and <body>.
  recorderDocument.body.before(recorderDocument.createTextNode("\n"));
  await flush();

  // Step 2: build and mount a subtree into the existing #root (mirrors a
  // framework's first render after the module script in <body>).
  const root = recorderDocument.getElementById("root");
  if (!root) {
    throw new Error("Scenario seed is missing #root");
  }
  const main = recorderDocument.createElement("main");
  const heading = recorderDocument.createElement("h1");
  heading.textContent = "Trending 0";
  const paragraph = recorderDocument.createElement("p");
  paragraph.textContent = "count: 0";
  main.append(heading, paragraph);
  root.append(main);
  await flush();

  // Step 3: deep text updates resolved through a parent anchor id.
  if (heading.firstChild && paragraph.firstChild) {
    heading.firstChild.nodeValue = "Trending 1";
    paragraph.firstChild.nodeValue = "count: 1";
  }
  await flush();

  // Step 4: attribute mutation on an existing element.
  heading.setAttribute("data-count", "1");
  await flush();

  // Step 5: insert a new element between existing siblings.
  const badge = recorderDocument.createElement("span");
  badge.textContent = "new";
  paragraph.before(badge);
  await flush();

  // Step 6: remove an element.
  heading.remove();
  await flush();

  // Step 7: append a body-level node *after* the module script. Its recorded
  // index only stays valid on replay if the seed keeps the script in place.
  const footer = recorderDocument.createElement("footer");
  footer.textContent = "Footer";
  recorderDocument.body.append(footer);
  await flush();

  // Step 8: bulk-insert enough children in a single mutation (>20) to trip the
  // recorder's `replace_subtree` coalescing, exercising the realm-safe subtree
  // reconciliation on replay (the path that previously used cross-realm morphdom).
  const list = recorderDocument.createElement("ul");
  recorderDocument.body.append(list);
  await flush();

  const fragment = recorderDocument.createDocumentFragment();
  for (let item = 0; item < 25; item++) {
    const listItem = recorderDocument.createElement("li");
    listItem.textContent = "item " + item;
    fragment.append(listItem);
  }
  list.append(fragment);
  await flush();

  // Step 9: mutate a child created by the bulk insert. Its ref resolves on
  // replay only if the replace_subtree HTML captured marker ids for the subtree.
  const firstItem = list.firstChild;
  if (firstItem?.firstChild) {
    firstItem.firstChild.nodeValue = "item updated";
  }
  await flush();

  const liveHtml = recorderDocument.documentElement.outerHTML;

  const seed = messages.find((message) => message.type === RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE)
    ?.payload as PreviewInitialDocument | undefined;

  if (!seed) {
    throw new Error("Recorder did not emit an initial document");
  }

  const batches = messages
    .filter((message) => message.type === RUNTIME_PATCH_BATCH_MESSAGE_TYPE)
    .map((message) => message.payload as PreviewDomPatchBatch);

  return {
    seed,
    batches,
    ops: batches.flatMap((batch) => batch.ops),
    liveHtml,
  };
}

describe("preview patch replay", () => {
  it("replays a recorded runtime session into an identical DOM", async () => {
    const scenario = await recordScenario();

    expect(scenario.batches.length).toBeGreaterThan(0);
    // Guard that the bulk-insert step actually produced a replace_subtree op, so
    // this test genuinely covers the realm-safe subtree reconciliation path.
    expect(scenario.ops.some((op) => op.op === "replace_subtree")).toBe(true);

    const iframe = document.createElement("iframe");
    document.body.append(iframe);

    const contentDocument = iframe.contentDocument;
    if (!contentDocument) {
      throw new Error("iframe has no content document");
    }

    // Replay the seed exactly as production does: through the bridge's
    // structure-preserving transform, not the raw recorder output.
    const seedHtml = createPatchReplaySeedFromHtml(scenario.seed.html, REPLAY_BASE_URL);
    if (!seedHtml) {
      throw new Error("Seed transform returned null");
    }
    const transformedSeed = { ...scenario.seed, html: seedHtml };

    expect(applyPreviewInitialDocumentToIframe(iframe, transformedSeed)).toBe(true);

    for (const batch of scenario.batches) {
      const result = applyPreviewDomPatchBatchToIframe(iframe, batch);
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    }

    expect(normalizeHtml(contentDocument.documentElement.outerHTML)).toBe(
      normalizeHtml(scenario.liveHtml),
    );

    iframe.remove();
  });

  it("gives recorded nodes a marker identity that survives serialization", async () => {
    const scenario = await recordScenario();

    expect(scenario.seed.html).toContain(PREVIEW_REPLAY_NODE_ID_ATTRIBUTE);

    const setTextOps = scenario.ops.filter((op): op is PreviewSetTextOp => op.op === "set_text");

    expect(setTextOps.length).toBeGreaterThan(0);
    expect(setTextOps.some((op) => typeof op.target.anchorId === "string")).toBe(true);
  });

  it("captures a complete seed without emitting a phantom body insert", async () => {
    const scenario = await recordScenario();

    expect(scenario.seed.html).toContain("<body");

    const insertedTagNames = scenario.ops
      .filter((op): op is PreviewInsertNodeOp => op.op === "insert_node")
      .map((op) => op.node.tagName);

    expect(insertedTagNames).not.toContain("body");
  });
});

describe("preview patch apply", () => {
  const DOCUMENT_ID = "doc-1";

  function getDoc(iframe: HTMLIFrameElement): Document {
    const doc = iframe.contentDocument;
    if (!doc) {
      throw new Error("iframe has no content document");
    }
    return doc;
  }

  function seedIframe(bodyHtml: string): HTMLIFrameElement {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);

    const seed: PreviewInitialDocument = {
      version: 1,
      time: 0,
      documentId: DOCUMENT_ID,
      route: "/",
      html:
        "<!doctype html><html><head></head>" +
        `<body ${PREVIEW_REPLAY_NODE_ID_ATTRIBUTE}="body">${bodyHtml}</body></html>`,
    };

    if (!applyPreviewInitialDocumentToIframe(iframe, seed)) {
      throw new Error("seed failed to apply");
    }

    return iframe;
  }

  function makeBatch(ops: PreviewDomPatchOp[]): PreviewDomPatchBatch {
    return {
      version: 1,
      time: 0,
      source: "runtime-preview",
      documentId: DOCUMENT_ID,
      baseRevision: 0,
      revision: 1,
      route: "/",
      ops,
    };
  }

  function markerSelector(id: string): string {
    return `[${PREVIEW_REPLAY_NODE_ID_ATTRIBUTE}="${id}"]`;
  }

  it("skips an unresolvable op and still applies the rest (fail soft)", () => {
    const iframe = seedIframe(`<div ${PREVIEW_REPLAY_NODE_ID_ATTRIBUTE}="n1">x</div>`);
    const doc = getDoc(iframe);

    const result = applyPreviewDomPatchBatchToIframe(
      iframe,
      makeBatch([
        {
          op: "set_attribute",
          target: { id: "n1", path: [] },
          name: "data-ok",
          value: "1",
          namespaceURI: null,
        },
        {
          op: "set_attribute",
          target: { id: "missing", path: [] },
          name: "data-bad",
          value: "1",
          namespaceURI: null,
        },
      ]),
    );

    expect(result.ok).toBe(true);
    expect(result.appliedOps).toBe(1);
    expect(result.failedOps).toBe(1);
    expect(result.firstFailedOpIndex).toBe(1);
    expect(doc.querySelector(markerSelector("n1"))?.getAttribute("data-ok")).toBe("1");

    iframe.remove();
  });

  it("moves a node and sets element properties", () => {
    const iframe = seedIframe(
      `<p ${PREVIEW_REPLAY_NODE_ID_ATTRIBUTE}="p1">first</p>` +
        `<input ${PREVIEW_REPLAY_NODE_ID_ATTRIBUTE}="in1" />`,
    );
    const doc = getDoc(iframe);

    const result = applyPreviewDomPatchBatchToIframe(
      iframe,
      makeBatch([
        {
          op: "move_node",
          target: { id: "in1", path: [] },
          parent: { id: "body", path: [] },
          index: 0,
        },
        { op: "set_property", target: { id: "in1", path: [] }, name: "value", value: "typed" },
      ]),
    );

    expect(result.ok).toBe(true);
    expect(result.failedOps).toBe(0);

    const firstChild = doc.body.firstChild as Element;
    expect(firstChild.getAttribute(PREVIEW_REPLAY_NODE_ID_ATTRIBUTE)).toBe("in1");
    expect((doc.querySelector(markerSelector("in1")) as HTMLInputElement).value).toBe("typed");

    iframe.remove();
  });

  it("applies namespaced attributes", () => {
    const iframe = seedIframe(`<svg ${PREVIEW_REPLAY_NODE_ID_ATTRIBUTE}="svg1"></svg>`);
    const doc = getDoc(iframe);
    const xlink = "http://www.w3.org/1999/xlink";

    const result = applyPreviewDomPatchBatchToIframe(
      iframe,
      makeBatch([
        {
          op: "set_attribute",
          target: { id: "svg1", path: [] },
          name: "href",
          value: "#icon",
          namespaceURI: xlink,
        },
      ]),
    );

    expect(result.ok).toBe(true);
    expect(result.failedOps).toBe(0);
    expect(doc.querySelector(markerSelector("svg1"))?.getAttributeNS(xlink, "href")).toBe("#icon");

    iframe.remove();
  });

  it("neutralizes scripts, inline handlers, and javascript: urls in the seed", () => {
    const seed = createPatchReplaySeedFromHtml(
      "<html><head><title>T</title></head><body>" +
        '<img src="x.png" onerror="window.__pwn = 1" />' +
        '<a href="javascript:window.__pwn = 2">link</a>' +
        '<script src="/app.js">doStuff()</script>' +
        "</body></html>",
      REPLAY_BASE_URL,
    );

    expect(seed).not.toBeNull();
    const html = seed as string;
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('src="/app.js"');
    expect(html).toContain('type="application/x-next-editor-inert-script"');
    expect(html).toContain("<script");
    expect(html).toContain("<base");
  });

  it("neutralizes inline handlers on inserted nodes", () => {
    const iframe = seedIframe(`<div ${PREVIEW_REPLAY_NODE_ID_ATTRIBUTE}="host"></div>`);
    const doc = getDoc(iframe);

    const result = applyPreviewDomPatchBatchToIframe(
      iframe,
      makeBatch([
        {
          op: "insert_node",
          parent: { id: "host", path: [] },
          index: 0,
          node: {
            kind: "element",
            tagName: "img",
            namespaceURI: null,
            attributes: [
              ["src", "x.png"],
              ["onerror", "window.__pwn = 1"],
            ],
            children: [],
          },
        },
      ]),
    );

    expect(result.ok).toBe(true);
    const inserted = doc.querySelector(markerSelector("host"))?.firstElementChild;
    expect(inserted?.tagName.toLowerCase()).toBe("img");
    expect(inserted?.hasAttribute("onerror")).toBe(false);

    iframe.remove();
  });
});
