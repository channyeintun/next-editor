const FORBIDDEN_ELEMENTS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "base",
  "meta",
  "link",
  "form",
  "foreignobject",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
]);

const URL_ATTRIBUTES = new Set(["href", "src", "xlink:href", "action", "formaction"]);

function isSafeUrl(value: string, elementName: string): boolean {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f\s]/g, "").toLowerCase();
  if (normalized.startsWith("javascript:") || normalized.startsWith("vbscript:")) return false;
  if (normalized.startsWith("data:")) {
    return elementName === "img" || elementName === "image"
      ? /^data:image\/(?:png|gif|jpe?g|webp|avif|svg\+xml);/i.test(value.trim())
      : false;
  }
  return true;
}

function sanitizeElement(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on")) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (URL_ATTRIBUTES.has(name) && !isSafeUrl(attribute.value, element.localName.toLowerCase())) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (
      name === "style" &&
      /(?:expression\s*\(|@import|[-\w]*binding\s*:|url\s*\(\s*["']?\s*(?:javascript|vbscript):)/i.test(
        attribute.value,
      )
    ) {
      element.removeAttribute(attribute.name);
    }
  }
}

/**
 * Removes executable and navigation-capable markup from lesson-controlled HTML/SVG.
 * Styling, ordinary layout, IDs, and remote image URLs are retained so authored and
 * imported slides continue to render and Google-Slides step animation can target nodes.
 */
export function sanitizeSlideContent(content: string, mimeType: "text/html" | "image/svg+xml") {
  const document = new DOMParser().parseFromString(content, mimeType);
  const root = mimeType === "text/html" ? document.body : document.documentElement;

  sanitizeElement(root);

  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (FORBIDDEN_ELEMENTS.has(element.localName.toLowerCase())) {
      element.remove();
      continue;
    }
    sanitizeElement(element);
  }

  return mimeType === "text/html" ? root.innerHTML : root.outerHTML;
}
