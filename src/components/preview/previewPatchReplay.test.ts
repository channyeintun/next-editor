import { describe, expect, it } from "vite-plus/test";
import { JSDOM } from "jsdom";
import type { DOMWindow } from "jsdom";
import { createRuntimePatchRecorderScript } from "../../contexts/webContainerRuntimeSupport";
import {
  applyPreviewDomPatchBatchToIframe,
  applyPreviewInitialDocumentToIframe,
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

const SEED_HTML = "<!DOCTYPE html><html><head><title>App</title></head><body></body></html>";

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
  return html
    .replaceAll(/\s+data-next-editor-preview-node-id="[^"]*"/g, "")
    .replaceAll(/\s+type="application\/x-next-editor-inert-script"/g, "")
    .replaceAll(/>\s+</g, "><")
    .trim();
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

  // Step 2: build and mount a subtree (mirrors a framework's first render).
  const main = recorderDocument.createElement("main");
  const heading = recorderDocument.createElement("h1");
  heading.textContent = "Trending 0";
  const paragraph = recorderDocument.createElement("p");
  paragraph.textContent = "count: 0";
  main.append(heading, paragraph);
  recorderDocument.body.append(main);
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

    const iframe = document.createElement("iframe");
    document.body.append(iframe);

    const contentDocument = iframe.contentDocument;
    if (!contentDocument) {
      throw new Error("iframe has no content document");
    }

    expect(applyPreviewInitialDocumentToIframe(iframe, scenario.seed)).toBe(true);

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
