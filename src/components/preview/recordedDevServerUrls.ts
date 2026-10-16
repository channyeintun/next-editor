import type { eventWithTime } from "@rrweb/types";
import { RRWEB_EVENT_TYPE, RRWEB_INCREMENTAL_SOURCE } from "../../core/src/preview";
import { isWorkspaceTextFile, type WorkspaceFile } from "../../types/workspace";
import { getWorkspaceFileMimeType } from "../../types/workspaceFiles";

// rrweb's serialized node types for an element and a text node
// (rrweb-snapshot NodeType.Element / NodeType.Text).
const RRWEB_ELEMENT_NODE = 2;
const RRWEB_TEXT_NODE = 3;

// A CSS url(), its target double-, single- or un-quoted. rrweb writes the
// targets it absolutized quoted.
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')\s]*))\s*\)/g;

interface RecordedNode {
  id?: number;
  type?: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  textContent?: string;
  childNodes?: RecordedNode[];
}

type ReadWorkspaceFile = (path: string) => WorkspaceFile | null;

/**
 * What the chunks of one replay's event stream rewritten so far established.
 * A streamed recording is rewritten a chunk at a time, and a later chunk's
 * mutations refer to the dev server and the `<style>` nodes an earlier chunk
 * recorded. Create one per replay build and pass it with every chunk, in order.
 */
export interface RecordedDevServerStream {
  /** The recorded dev server's origins, from the Meta events. */
  readonly origins: Set<string>;
  /** The recorded page's URL, from the latest Meta event. */
  pageHref: string | undefined;
  /** rrweb ids of the current document's `<style>` elements. */
  readonly styleIds: Set<number>;
  /** rrweb ids of the text nodes inside those `<style>`s. */
  readonly styleTextIds: Set<number>;
}

export function createRecordedDevServerStream(): RecordedDevServerStream {
  return { origins: new Set(), pageHref: undefined, styleIds: new Set(), styleTextIds: new Set() };
}

interface RecordedDevServer {
  /** Whether a URL addresses the recorded dev server. */
  serves: (url: unknown) => boolean;
  /** The workspace data: URL for a recorded-host image URL, or null. */
  resolve: (src: unknown) => string | null;
}

/** One serialized node's own changes: attributes to set or drop, its text. */
interface NodeReplacements {
  attributes?: Record<string, unknown>;
  removedAttributes?: string[];
  textContent?: string;
}

/**
 * Make the recorded references to the lesson's own dev server replayable.
 *
 * Images — `<img src>`s and CSS `url()`s — are pointed at the file in the
 * recorded workspace instead.
 *
 * The recorder serializes an image's src as an absolute URL on the WebContainer
 * the lesson was recorded in (`https://<id>--5173--….webcontainer-api.io/logo.svg`),
 * and rrweb absolutizes a stylesheet's `url(/dot.svg)` onto it the same way
 * (in an inlined `<link>`'s `_cssText`, a `<style>`'s text, a `style`
 * attribute). That container is gone by playback, and the replay frame is a
 * nexteditor.dev document anyway, so every viewer's request 404s and the image
 * never shows. The workspace is restored to the recorded files during
 * playback, so a file the dev server served from `public/` (or by its own
 * path) is still there to show. Images the workspace cannot answer with text
 * keep their URL.
 *
 * rrweb records a style property set through `element.style`, and a
 * `<style>`'s text changed in place, as written (`url("/logo.svg")`). A
 * relative `url()` resolves against the recorded page's URL, as it did live;
 * in the replay frame it would resolve against nexteditor.dev.
 *
 * A stylesheet `<link>` rrweb has not inlined yet loses its `href`: rrweb
 * inlines it as `_cssText` once it loads, and replay then turns the link into
 * a `<style>` with that CSS, so its URL only ever made the replay request the
 * dead dev server. Vite's link-mode CSS HMR swaps in such a link
 * (`styles.css?t=…`) on every edit.
 *
 * Text is rewritten only inside a `<style>`: a page can also show such a
 * `url()` as text (a computed style it prints), which must replay as recorded.
 *
 * Events that need no change are returned as they are; the others are cloned
 * first, because the events belong to the loaded recording.
 *
 * The dev server's origin comes from the Meta events. A streamed append can be
 * patch batches alone, with no Meta of its own, and its text changes refer to
 * `<style>` nodes an earlier chunk added, so every chunk of one replay passes
 * the same `stream`.
 */
export function withRecordedDevServerUrls(
  events: eventWithTime[],
  readWorkspaceFile: ReadWorkspaceFile,
  stream: RecordedDevServerStream = createRecordedDevServerStream(),
): eventWithTime[] {
  const { origins } = stream;
  for (const event of events) {
    if (event.type === RRWEB_EVENT_TYPE.Meta) {
      const origin = originOf((event.data as { href?: unknown }).href);
      if (origin) origins.add(origin);
    }
  }
  if (origins.size === 0) return events;

  const dataUrls = new Map<string, string | null>();
  const devServer: RecordedDevServer = {
    serves: (url) => origins.has(originOf(url) ?? ""),
    resolve: (src) => {
      if (typeof src !== "string") return null;
      let url: URL;
      let path: string;
      try {
        url = new URL(src, stream.pageHref);
        // A stray "%" survives new URL() and makes decodeURIComponent throw; that
        // would escape the replay step, so such a src just keeps its URL.
        path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      } catch {
        return null;
      }
      if (!origins.has(url.origin)) return null;
      if (!dataUrls.has(path)) {
        dataUrls.set(path, workspaceDataUrl(path, readWorkspaceFile));
      }
      const dataUrl = dataUrls.get(path);
      // The fragment picks an SVG sprite's <view> (or :target) on the data:
      // URL just as on the file; without it every icon showed the whole sprite.
      return dataUrl ? `${dataUrl}${url.hash}` : null;
    },
  };

  return events.map((event) => {
    if (event.type === RRWEB_EVENT_TYPE.Meta) {
      const { href } = event.data as { href?: unknown };
      // Only a valid base: new URL() throws on an invalid one, even for an
      // absolute URL.
      if (typeof href === "string" && originOf(href)) stream.pageHref = href;
      return event;
    }
    return withReplayableUrls(event, devServer, stream);
  });
}

function withReplayableUrls(
  event: eventWithTime,
  devServer: RecordedDevServer,
  stream: RecordedDevServerStream,
): eventWithTime {
  if (event.type === RRWEB_EVENT_TYPE.FullSnapshot) {
    // A rebuild starts a fresh document, which may renumber its nodes.
    stream.styleIds.clear();
    stream.styleTextIds.clear();
    const data = event.data as { node?: RecordedNode };
    if (!data.node || !scanReplacements(data.node, false, devServer, stream)) return event;
    const copy = structuredClone(event);
    applyReplacements((copy.data as { node: RecordedNode }).node, false, devServer);
    return copy;
  }

  if (event.type === RRWEB_EVENT_TYPE.IncrementalSnapshot) {
    const data = event.data as {
      source?: number;
      adds?: { parentId: number; node: RecordedNode }[];
      texts?: { id: number; value: unknown }[];
      attributes?: { attributes: Record<string, unknown> }[];
    };
    if (data.source !== RRWEB_INCREMENTAL_SOURCE.Mutation) return event;
    const { resolve } = devServer;
    const { styleIds, styleTextIds } = stream;
    // rrweb adds a node only after its parent has an id, so a <style> added in
    // this batch is known before the text added to it. Every add is scanned.
    let changesAdds = false;
    for (const add of data.adds ?? []) {
      const inStyle = styleIds.has(add.parentId);
      changesAdds = scanReplacements(add.node, inStyle, devServer, stream) || changesAdds;
    }
    const setsImage = data.attributes?.some(
      (change) => attributeChangeImages(change.attributes, resolve) !== null,
    );
    const styleText = (text: { id: number; value: unknown }) =>
      styleTextIds.has(text.id) ? resolveCssUrls(text.value, resolve) : null;
    const textsImage = data.texts?.some((text) => styleText(text) !== null);
    if (!changesAdds && !setsImage && !textsImage) return event;
    const copy = structuredClone(event);
    const copyData = copy.data as typeof data;
    for (const add of copyData.adds ?? []) {
      applyReplacements(add.node, styleIds.has(add.parentId), devServer);
    }
    for (const change of copyData.attributes ?? []) {
      Object.assign(change.attributes, attributeChangeImages(change.attributes, resolve));
    }
    for (const text of copyData.texts ?? []) {
      text.value = styleText(text) ?? text.value;
    }
    return copy;
  }

  return event;
}

function isImage(node: RecordedNode): boolean {
  return node.type === RRWEB_ELEMENT_NODE && node.tagName?.toLowerCase() === "img";
}

function isStyle(node: RecordedNode): boolean {
  return node.type === RRWEB_ELEMENT_NODE && node.tagName?.toLowerCase() === "style";
}

/**
 * `css` with every `url()` the workspace can answer pointed at its data: URL,
 * or null when it has none. rrweb absolutizes only stylesheet text, so a
 * recorded-host `url()` in a stylesheet or style value is CSS.
 */
function resolveCssUrls(css: unknown, resolve: RecordedDevServer["resolve"]): string | null {
  if (typeof css !== "string" || !css.includes("url(")) return null;
  let changed = false;
  const resolvedCss = css.replace(
    CSS_URL,
    (match, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
      const resolved = resolve(doubleQuoted ?? singleQuoted ?? bare);
      if (resolved === null) return match;
      changed = true;
      return `url("${resolved}")`;
    },
  );
  return changed ? resolvedCss : null;
}

/**
 * The serialized node's own replacements, if it needs any. `inStyle`: its
 * parent is a `<style>`, so its text is CSS.
 */
function nodeReplacements(
  node: RecordedNode,
  inStyle: boolean,
  { serves, resolve }: RecordedDevServer,
): NodeReplacements | null {
  if (node.type === RRWEB_TEXT_NODE) {
    if (!inStyle) return null;
    const textContent = resolveCssUrls(node.textContent, resolve);
    return textContent === null ? null : { textContent };
  }
  if (node.type !== RRWEB_ELEMENT_NODE || !node.attributes) return null;
  const attributes: Record<string, unknown> = {};
  const src = isImage(node) ? resolve(node.attributes.src) : null;
  if (src !== null) attributes.src = src;
  // An inlined stylesheet (<link> or <style>) and an inline style attribute.
  for (const name of ["_cssText", "style"]) {
    const css = resolveCssUrls(node.attributes[name], resolve);
    if (css !== null) attributes[name] = css;
  }
  const removedAttributes =
    isStylesheetLink(node) && !("_cssText" in node.attributes) && serves(node.attributes.href)
      ? ["href"]
      : [];
  if (Object.keys(attributes).length === 0 && removedAttributes.length === 0) return null;
  return { attributes, removedAttributes };
}

function isStylesheetLink(node: RecordedNode): boolean {
  const rel = node.attributes?.rel;
  return (
    node.tagName?.toLowerCase() === "link" &&
    typeof rel === "string" &&
    /(?:^|\s)stylesheet(?:\s|$)/i.test(rel)
  );
}

/**
 * Replacements for an attribute mutation's image references, or null. It
 * carries no tag name; only a recorded-host src can be an image the dev server
 * answered, so any such src is rewritten. rrweb records a `style` change as a
 * string or as a per-property diff (`value` or `[value, priority]`).
 */
function attributeChangeImages(
  attributes: Record<string, unknown>,
  resolve: RecordedDevServer["resolve"],
): Record<string, unknown> | null {
  const replacements: Record<string, unknown> = {};
  const src = resolve(attributes.src);
  if (src !== null) replacements.src = src;
  const cssText = resolveCssUrls(attributes._cssText, resolve);
  if (cssText !== null) replacements._cssText = cssText;
  const style = attributes.style;
  if (typeof style === "string") {
    const resolvedStyle = resolveCssUrls(style, resolve);
    if (resolvedStyle !== null) replacements.style = resolvedStyle;
  } else if (style && typeof style === "object") {
    let changed = false;
    const diff: Record<string, unknown> = {};
    for (const [property, value] of Object.entries(style)) {
      const css = resolveCssUrls(Array.isArray(value) ? value[0] : value, resolve);
      diff[property] = css === null ? value : Array.isArray(value) ? [css, value[1]] : css;
      changed ||= css !== null;
    }
    if (changed) replacements.style = diff;
  }
  return Object.keys(replacements).length > 0 ? replacements : null;
}

/**
 * Whether `node` or a node inside it needs a replacement. It walks the whole
 * tree, so that `stream` learns every `<style>` and `<style>` text node in it.
 */
function scanReplacements(
  node: RecordedNode,
  inStyle: boolean,
  devServer: RecordedDevServer,
  stream: RecordedDevServerStream,
): boolean {
  const style = isStyle(node);
  if (node.id !== undefined) {
    if (style) stream.styleIds.add(node.id);
    else if (inStyle && node.type === RRWEB_TEXT_NODE) stream.styleTextIds.add(node.id);
  }
  let needed = nodeReplacements(node, inStyle, devServer) !== null;
  for (const child of node.childNodes ?? []) {
    needed = scanReplacements(child, style, devServer, stream) || needed;
  }
  return needed;
}

function applyReplacements(
  node: RecordedNode,
  inStyle: boolean,
  devServer: RecordedDevServer,
): void {
  const replacements = nodeReplacements(node, inStyle, devServer);
  if (replacements?.textContent !== undefined) node.textContent = replacements.textContent;
  if (replacements && node.attributes) {
    Object.assign(node.attributes, replacements.attributes);
    for (const name of replacements.removedAttributes ?? []) delete node.attributes[name];
  }
  const style = isStyle(node);
  for (const child of node.childNodes ?? []) applyReplacements(child, style, devServer);
}

function originOf(href: unknown): string | null {
  if (typeof href !== "string") return null;
  try {
    return new URL(href).origin;
  } catch {
    return null;
  }
}

/**
 * A `data:` URL for the workspace image the dev server would have answered with:
 * Vite serves `public/<path>` at `/<path>`, and a source file at its own path.
 * Only image files qualify, so a recorded-host src on anything else (an
 * attribute mutation does not say which element it belongs to) stays as it is.
 */
function workspaceDataUrl(path: string, readWorkspaceFile: ReadWorkspaceFile): string | null {
  if (!path) return null;
  for (const candidate of [`public/${path}`, path]) {
    const mimeType = getWorkspaceFileMimeType(candidate);
    if (!mimeType.startsWith("image/")) continue;
    const file = readWorkspaceFile(candidate);
    if (file && isWorkspaceTextFile(file)) {
      return `data:${mimeType};charset=utf-8,${encodeURIComponent(file.content)}`;
    }
  }
  return null;
}
