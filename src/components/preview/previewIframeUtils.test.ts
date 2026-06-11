import { describe, expect, it } from "vite-plus/test";
import { patchIframeContentFromHtml } from "./previewIframeUtils";

function createIframeWithContent(htmlContent: string): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);

  const iframeDocument = iframe.contentDocument;
  if (!iframeDocument) {
    throw new Error("Expected iframe document to be available");
  }

  iframeDocument.open();
  iframeDocument.write(htmlContent);
  iframeDocument.close();

  return iframe;
}

describe("patchIframeContentFromHtml", () => {
  it("patches text, attributes, and children without replacing matching elements", () => {
    const iframe = createIframeWithContent(`<!doctype html>
<html lang="en">
  <head><title>Loading</title></head>
  <body>
    <main id="app">
      <h1>Loading</h1>
      <button disabled>Fetch</button>
      <ul><li>Old</li></ul>
    </main>
  </body>
</html>`);

    const iframeDocument = iframe.contentDocument!;
    const app = iframeDocument.querySelector("#app");
    const button = iframeDocument.querySelector("button");

    const didPatch = patchIframeContentFromHtml(
      iframe,
      `<!doctype html>
<html lang="en">
  <head><title>Loaded</title></head>
  <body>
    <main id="app" data-ready="true">
      <h1>Loaded</h1>
      <button>Fetch</button>
      <ul><li>New</li><li>Another</li></ul>
    </main>
  </body>
</html>`,
    );

    expect(didPatch).toBe(true);
    expect(iframeDocument.querySelector("#app")).toBe(app);
    expect(iframeDocument.querySelector("button")).toBe(button);
    expect(iframeDocument.title).toBe("Loaded");
    expect(app).toHaveAttribute("data-ready", "true");
    expect(button).not.toHaveAttribute("disabled");
    expect(iframeDocument.querySelector("h1")).toHaveTextContent("Loaded");
    expect(Array.from(iframeDocument.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
      "New",
      "Another",
    ]);
  });

  it("replaces incompatible child elements", () => {
    const iframe = createIframeWithContent(`<!doctype html>
<html>
  <head></head>
  <body><main><p id="slot">Old</p></main></body>
</html>`);

    const iframeDocument = iframe.contentDocument!;
    const oldSlot = iframeDocument.querySelector("#slot");

    const didPatch = patchIframeContentFromHtml(
      iframe,
      `<!doctype html>
<html>
  <head></head>
  <body><main><section id="slot">New</section></main></body>
</html>`,
    );

    const newSlot = iframeDocument.querySelector("#slot");

    expect(didPatch).toBe(true);
    expect(newSlot).not.toBe(oldSlot);
    expect(newSlot?.tagName).toBe("SECTION");
    expect(newSlot).toHaveTextContent("New");
  });
});
