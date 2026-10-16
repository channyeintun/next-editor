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
  type?: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  textContent?: string;
  childNodes?: RecordedNode[];
}

type ReadWorkspaceFile = (path: string) => WorkspaceFile | null;
type ResolveSource = (src: unknown) => string | null;

/**
 * Point the recorded image references that address the lesson's own dev server
 * — `<img src>`s and CSS `url()`s — at the file in the recorded workspace
 * instead.
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
 * Events whose images need no change are returned as they are; the others are
 * cloned first, because the events belong to the loaded recording.
 *
 * The dev server's origin comes from the Meta events in `originEvents`. A
 * streamed append can be patch batches alone, with no Meta of its own, so the
 * append passes the recording's initial documents there.
 */
export function withRecordedImageSources(
  events: eventWithTime[],
  readWorkspaceFile: ReadWorkspaceFile,
  originEvents: readonly { type: number; data: unknown }[] = events,
): eventWithTime[] {
  const origins = new Set<string>();
  for (const event of originEvents) {
    if (event.type === RRWEB_EVENT_TYPE.Meta) {
      const origin = originOf((event.data as { href?: unknown }).href);
      if (origin) origins.add(origin);
    }
  }
  if (origins.size === 0) return events;

  const dataUrls = new Map<string, string | null>();
  const resolve: ResolveSource = (src) => {
    if (typeof src !== "string") return null;
    let url: URL;
    let path: string;
    try {
      url = new URL(src);
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
    return dataUrls.get(path) ?? null;
  };

  return events.map((event) => withResolvedImages(event, resolve));
}

function withResolvedImages(event: eventWithTime, resolve: ResolveSource): eventWithTime {
  if (event.type === RRWEB_EVENT_TYPE.FullSnapshot) {
    const data = event.data as { node?: RecordedNode };
    if (!data.node || !hasResolvableImage(data.node, resolve)) return event;
    const copy = structuredClone(event);
    rewriteImages((copy.data as { node: RecordedNode }).node, resolve);
    return copy;
  }

  if (event.type === RRWEB_EVENT_TYPE.IncrementalSnapshot) {
    const data = event.data as {
      source?: number;
      adds?: { node: RecordedNode }[];
      texts?: { value: unknown }[];
      attributes?: { attributes: Record<string, unknown> }[];
    };
    if (data.source !== RRWEB_INCREMENTAL_SOURCE.Mutation) return event;
    const addsImage = data.adds?.some((add) => hasResolvableImage(add.node, resolve));
    const setsImage = data.attributes?.some(
      (change) => attributeChangeImages(change.attributes, resolve) !== null,
    );
    const textsImage = data.texts?.some((text) => resolveCssUrls(text.value, resolve) !== null);
    if (!addsImage && !setsImage && !textsImage) return event;
    const copy = structuredClone(event);
    const copyData = copy.data as typeof data;
    for (const add of copyData.adds ?? []) rewriteImages(add.node, resolve);
    for (const change of copyData.attributes ?? []) {
      Object.assign(change.attributes, attributeChangeImages(change.attributes, resolve));
    }
    for (const text of copyData.texts ?? []) {
      text.value = resolveCssUrls(text.value, resolve) ?? text.value;
    }
    return copy;
  }

  return event;
}

function isImage(node: RecordedNode): boolean {
  return node.type === RRWEB_ELEMENT_NODE && node.tagName?.toLowerCase() === "img";
}

/**
 * `css` with every `url()` the workspace can answer pointed at its data: URL,
 * or null when it has none. rrweb absolutizes only stylesheet text, so a
 * recorded-host `url()` in any text or style value is CSS.
 */
function resolveCssUrls(css: unknown, resolve: ResolveSource): string | null {
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

/** The serialized node's own references the workspace can answer, if any. */
function nodeImages(node: RecordedNode, resolve: ResolveSource): Partial<RecordedNode> | null {
  if (node.type === RRWEB_TEXT_NODE) {
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
  return Object.keys(attributes).length > 0 ? { attributes } : null;
}

/**
 * Replacements for an attribute mutation's image references, or null. It
 * carries no tag name; only a recorded-host src can be an image the dev server
 * answered, so any such src is rewritten. rrweb records a `style` change as a
 * string or as a per-property diff (`value` or `[value, priority]`).
 */
function attributeChangeImages(
  attributes: Record<string, unknown>,
  resolve: ResolveSource,
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

function hasResolvableImage(node: RecordedNode, resolve: ResolveSource): boolean {
  if (nodeImages(node, resolve) !== null) return true;
  return node.childNodes?.some((child) => hasResolvableImage(child, resolve)) ?? false;
}

function rewriteImages(node: RecordedNode, resolve: ResolveSource): void {
  const images = nodeImages(node, resolve);
  if (images?.textContent !== undefined) node.textContent = images.textContent;
  if (images?.attributes) Object.assign(node.attributes!, images.attributes);
  for (const child of node.childNodes ?? []) rewriteImages(child, resolve);
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
