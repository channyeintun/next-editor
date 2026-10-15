import type { eventWithTime } from "@rrweb/types";
import { describe, expect, it } from "vite-plus/test";
import { createWorkspaceFile } from "../../types/workspaceFiles";
import type { WorkspaceFile } from "../../types/workspace";
import { withRecordedImageSources } from "./recordedImageSources";

const HOST = "https://abc--5173--2ed8f36d.local-corp.webcontainer-api.io";
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
const LOGO_DATA_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(LOGO_SVG)}`;

const files: Record<string, WorkspaceFile> = {
  "public/logo.svg": createWorkspaceFile("public/logo.svg", LOGO_SVG),
  "src/main.jsx": createWorkspaceFile("src/main.jsx", "import './App.jsx';"),
};
const readWorkspaceFile = (path: string) => files[path] ?? null;

const meta = { type: 4, timestamp: 0, data: { href: `${HOST}/`, width: 432, height: 720 } };
const img = (src: string, id = 7) => ({
  type: 2,
  tagName: "img",
  attributes: { class: "logo", src },
  childNodes: [],
  id,
});

function asEvents(...events: object[]): eventWithTime[] {
  return events as unknown as eventWithTime[];
}

describe("withRecordedImageSources", () => {
  it("shows a public/ image the recorded dev server served, from the workspace", () => {
    const snapshot = {
      type: 2,
      timestamp: 1,
      data: {
        node: {
          type: 0,
          childNodes: [
            { type: 2, tagName: "main", attributes: {}, childNodes: [img(`${HOST}/logo.svg`)] },
          ],
        },
      },
    };
    const events = asEvents(meta, snapshot);

    const result = withRecordedImageSources(events, readWorkspaceFile);

    expect(JSON.stringify(result[1])).toContain(JSON.stringify(LOGO_DATA_URL));
    // The recording's own events are left as they were.
    expect(JSON.stringify(events[1])).toContain(`${HOST}/logo.svg`);
    expect(result[0]).toBe(events[0]);
  });

  it("rewrites images in added nodes and src attribute changes", () => {
    const mutation = {
      type: 3,
      timestamp: 2,
      data: {
        source: 0,
        texts: [],
        removes: [],
        adds: [{ parentId: 1, nextId: null, node: img(`${HOST}/logo.svg?v=1#x`) }],
        attributes: [{ id: 9, attributes: { src: `${HOST}/logo.svg` } }],
      },
    };

    const [, result] = withRecordedImageSources(
      asEvents(meta, mutation),
      readWorkspaceFile,
    ) as unknown as [unknown, { data: typeof mutation.data }];

    expect(result.data.adds[0].node.attributes.src).toBe(LOGO_DATA_URL);
    expect(result.data.attributes[0].attributes.src).toBe(LOGO_DATA_URL);
  });

  it("leaves other hosts, missing files and non-image files alone", () => {
    const mutation = {
      type: 3,
      timestamp: 2,
      data: {
        source: 0,
        texts: [],
        removes: [],
        adds: [
          { parentId: 1, nextId: null, node: img("https://example.com/logo.svg", 7) },
          { parentId: 1, nextId: null, node: img(`${HOST}/missing.png`, 8) },
        ],
        attributes: [{ id: 9, attributes: { src: `${HOST}/src/main.jsx` } }],
      },
    };
    const events = asEvents(meta, mutation);

    const result = withRecordedImageSources(events, readWorkspaceFile);

    expect(result[1]).toBe(events[1]);
  });

  it("takes the recorded host from the whole recording for a streamed append", () => {
    // An append of patch batches alone carries no Meta event of its own.
    const mutation = {
      type: 3,
      timestamp: 5,
      data: {
        source: 0,
        texts: [],
        removes: [],
        attributes: [],
        adds: [{ parentId: 1, nextId: null, node: img(`${HOST}/logo.svg`) }],
      },
    };

    const [result] = withRecordedImageSources(asEvents(mutation), readWorkspaceFile, [
      meta,
    ]) as unknown as [{ data: typeof mutation.data }];

    expect(result.data.adds[0].node.attributes.src).toBe(LOGO_DATA_URL);
  });

  it("keeps a src whose path cannot be decoded instead of throwing", () => {
    const mutation = {
      type: 3,
      timestamp: 2,
      data: {
        source: 0,
        texts: [],
        removes: [],
        adds: [],
        attributes: [{ id: 9, attributes: { src: `${HOST}/100%.png` } }],
      },
    };
    const events = asEvents(meta, mutation);

    expect(withRecordedImageSources(events, readWorkspaceFile)[1]).toBe(events[1]);
  });

  it("returns the events untouched when the stream has no recorded host", () => {
    const events = asEvents({ type: 3, timestamp: 1, data: { source: 1, positions: [] } });

    expect(withRecordedImageSources(events, readWorkspaceFile)).toBe(events);
  });
});
