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

/**
 * The image types a slide may carry as data: URLs, as a regex alternation.
 * slideImageCache.ts inlines only these, so a type added here is inlined too.
 */
export const SLIDE_INLINE_IMAGE_TYPES = "png|gif|jpe?g|webp|avif|svg\\+xml";

const IMAGE_DATA_URL = new RegExp(`^data:image/(?:${SLIDE_INLINE_IMAGE_TYPES});`, "i");

function isImageElement(elementName: string): boolean {
  return elementName === "img" || elementName === "image";
}

function isSafeUrl(value: string, elementName: string): boolean {
  const normalized = value
    .trim()
    // eslint-disable-next-line no-control-regex -- intentionally strips control characters to block obfuscated `javascript:`/`data:` URLs
    .replace(/[\u0000-\u001f\u007f\s]/g, "")
    .toLowerCase();
  if (normalized.startsWith("javascript:") || normalized.startsWith("vbscript:")) return false;
  if (normalized.startsWith("data:")) {
    return isImageElement(elementName) ? IMAGE_DATA_URL.test(value.trim()) : false;
  }
  return true;
}

function sanitizeElement(element: Element, inlineImages?: ReadonlyMap<string, string>): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on")) {
      element.removeAttribute(attribute.name);
      continue;
    }
    // A `nonce` on authored markup is never legitimate, and leaving it would
    // let content forge the value the slide document's CSP trusts for its own
    // animation bridge (see createSandboxedSlideDocument).
    if (name === "nonce") {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (URL_ATTRIBUTES.has(name)) {
      const elementName = element.localName.toLowerCase();
      if (!isSafeUrl(attribute.value, elementName)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      // An image the page already fetched (slideImageCache.ts) goes in as a data: URL,
      // held to the same rule as an authored one, so the frame never fetches it.
      const inlined = inlineImages?.get(attribute.value);
      if (inlined && isImageElement(elementName) && IMAGE_DATA_URL.test(inlined)) {
        attribute.value = inlined;
      }
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
export function sanitizeSlideContent(
  content: string,
  mimeType: "text/html" | "image/svg+xml",
  inlineImages?: ReadonlyMap<string, string>,
) {
  const document = new DOMParser().parseFromString(content, mimeType);
  const root = mimeType === "text/html" ? document.body : document.documentElement;

  // The root has to face the element check too, not just attribute scrubbing.
  // `querySelectorAll("*")` below enumerates descendants only, so for the SVG
  // branch — where `root` is whatever element the author put first and the
  // return value is `root.outerHTML` — a document whose root IS a forbidden
  // element (`<script>…</script>` parses fine as XML) passed straight through
  // with its own tag intact. Dropping the whole document is right here: the
  // root is the content, so there is nothing to salvage from it.
  if (FORBIDDEN_ELEMENTS.has(root.localName.toLowerCase())) {
    return "";
  }

  sanitizeElement(root, inlineImages);

  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (FORBIDDEN_ELEMENTS.has(element.localName.toLowerCase())) {
      element.remove();
      continue;
    }
    sanitizeElement(element, inlineImages);
  }

  return mimeType === "text/html" ? root.innerHTML : root.outerHTML;
}
