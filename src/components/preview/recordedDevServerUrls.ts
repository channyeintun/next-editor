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
 * A stylesheet `<link>` rrweb has not inlined yet loses its `href`: rrweb
 * inlines it as `_cssText` once it loads, and replay then turns the link into
 * a `<style>` with that CSS, so its URL only ever made the replay request the
 * dead dev server. Vite's link-mode CSS HMR swaps in such a link
 * (`styles.css?t=…`) on every edit.
 *
 * Events that need no change are returned as they are; the others are cloned
 * first, because the events belong to the loaded recording.
 *
 * The dev server's origin comes from the Meta events in `originEvents`. A
 * streamed append can be patch batches alone, with no Meta of its own, so the
 * append passes the recording's initial documents there.
 */
export function withRecordedDevServerUrls(
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
  const devServer: RecordedDevServer = {
    serves: (url) => origins.has(originOf(url) ?? ""),
    resolve: (src) => {
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
    },
  };

  return events.map((event) => withReplayableUrls(event, devServer));
}

function withReplayableUrls(event: eventWithTime, devServer: RecordedDevServer): eventWithTime {
  if (event.type === RRWEB_EVENT_TYPE.FullSnapshot) {
    const data = event.data as { node?: RecordedNode };
    if (!data.node || !hasReplacements(data.node, devServer)) return event;
    const copy = structuredClone(event);
    applyReplacements((copy.data as { node: RecordedNode }).node, devServer);
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
    const { resolve } = devServer;
    const changesAdds = data.adds?.some((add) => hasReplacements(add.node, devServer));
    const setsImage = data.attributes?.some(
      (change) => attributeChangeImages(change.attributes, resolve) !== null,
    );
    const textsImage = data.texts?.some((text) => resolveCssUrls(text.value, resolve) !== null);
    if (!changesAdds && !setsImage && !textsImage) return event;
    const copy = structuredClone(event);
    const copyData = copy.data as typeof data;
    for (const add of copyData.adds ?? []) applyReplacements(add.node, devServer);
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

/** The serialized node's own replacements, if it needs any. */
function nodeReplacements(
  node: RecordedNode,
  { serves, resolve }: RecordedDevServer,
): NodeReplacements | null {
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

function hasReplacements(node: RecordedNode, devServer: RecordedDevServer): boolean {
  if (nodeReplacements(node, devServer) !== null) return true;
  return node.childNodes?.some((child) => hasReplacements(child, devServer)) ?? false;
}

function applyReplacements(node: RecordedNode, devServer: RecordedDevServer): void {
  const replacements = nodeReplacements(node, devServer);
  if (replacements?.textContent !== undefined) node.textContent = replacements.textContent;
  if (replacements && node.attributes) {
    Object.assign(node.attributes, replacements.attributes);
    for (const name of replacements.removedAttributes ?? []) delete node.attributes[name];
  }
  for (const child of node.childNodes ?? []) applyReplacements(child, devServer);
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
