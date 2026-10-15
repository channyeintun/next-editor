import type { eventWithTime } from "@rrweb/types";
import { RRWEB_EVENT_TYPE, RRWEB_INCREMENTAL_SOURCE } from "../../core/src/preview";
import { isWorkspaceTextFile, type WorkspaceFile } from "../../types/workspace";
import { getWorkspaceFileMimeType } from "../../types/workspaceFiles";

// rrweb's serialized node type for an element (rrweb-snapshot NodeType.Element).
const RRWEB_ELEMENT_NODE = 2;

interface RecordedNode {
  type?: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: RecordedNode[];
}

type ReadWorkspaceFile = (path: string) => WorkspaceFile | null;

/**
 * Point the recorded `<img src>`s that address the lesson's own dev server at
 * the file in the recorded workspace instead.
 *
 * The recorder serializes an image's src as an absolute URL on the WebContainer
 * the lesson was recorded in (`https://<id>--5173--….webcontainer-api.io/logo.svg`).
 * That container is gone by playback, and the replay frame is a nexteditor.dev
 * document anyway, so every viewer's request 404s and the image never shows.
 * The workspace is restored to the recorded files during playback, so a file
 * the dev server served from `public/` (or by its own path) is still there to
 * show. Images the workspace cannot answer with text keep their URL.
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
  const resolve = (src: unknown): string | null => {
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

function withResolvedImages(
  event: eventWithTime,
  resolve: (src: unknown) => string | null,
): eventWithTime {
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
      attributes?: { attributes: Record<string, unknown> }[];
    };
    if (data.source !== RRWEB_INCREMENTAL_SOURCE.Mutation) return event;
    const addsImage = data.adds?.some((add) => hasResolvableImage(add.node, resolve));
    // An attribute mutation carries no tag name; only a recorded-host src can be
    // an image the dev server answered, so any such src is rewritten.
    const setsSrc = data.attributes?.some((change) => resolve(change.attributes.src) !== null);
    if (!addsImage && !setsSrc) return event;
    const copy = structuredClone(event);
    const copyData = copy.data as typeof data;
    for (const add of copyData.adds ?? []) rewriteImages(add.node, resolve);
    for (const change of copyData.attributes ?? []) {
      const resolved = resolve(change.attributes.src);
      if (resolved !== null) change.attributes.src = resolved;
    }
    return copy;
  }

  return event;
}

function isImage(node: RecordedNode): boolean {
  return node.type === RRWEB_ELEMENT_NODE && node.tagName?.toLowerCase() === "img";
}

function hasResolvableImage(node: RecordedNode, resolve: (src: unknown) => string | null): boolean {
  if (isImage(node) && resolve(node.attributes?.src) !== null) return true;
  return node.childNodes?.some((child) => hasResolvableImage(child, resolve)) ?? false;
}

function rewriteImages(node: RecordedNode, resolve: (src: unknown) => string | null): void {
  if (isImage(node) && node.attributes) {
    const resolved = resolve(node.attributes.src);
    if (resolved !== null) node.attributes.src = resolved;
  }
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
