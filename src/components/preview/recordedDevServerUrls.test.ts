import { Replayer } from "@rrweb/replay";
import type { eventWithTime } from "@rrweb/types";
import { describe, expect, it } from "vite-plus/test";
import { createWorkspaceFile } from "../../types/workspaceFiles";
import type { WorkspaceFile } from "../../types/workspace";
import { withRecordedDevServerUrls } from "./recordedDevServerUrls";

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

describe("withRecordedDevServerUrls", () => {
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

    const result = withRecordedDevServerUrls(events, readWorkspaceFile);

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

    const [, result] = withRecordedDevServerUrls(
      asEvents(meta, mutation),
      readWorkspaceFile,
    ) as unknown as [unknown, { data: typeof mutation.data }];

    // The query is the dev server's; the fragment still applies to the file.
    expect(result.data.adds[0].node.attributes.src).toBe(`${LOGO_DATA_URL}#x`);
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

    const result = withRecordedDevServerUrls(events, readWorkspaceFile);

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

    const [result] = withRecordedDevServerUrls(asEvents(mutation), readWorkspaceFile, [
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

    expect(withRecordedDevServerUrls(events, readWorkspaceFile)[1]).toBe(events[1]);
  });

  it("returns the events untouched when the stream has no recorded host", () => {
    const events = asEvents({ type: 3, timestamp: 1, data: { source: 1, positions: [] } });

    expect(withRecordedDevServerUrls(events, readWorkspaceFile)).toBe(events);
  });

  // rrweb absolutizes a stylesheet's url(/logo.svg) onto the recorded host.
  const css = (url: string) =>
    `.card { background-image: url("${url}"), url('https://example.com/a.png'), url(/relative.svg); }`;
  const resolvedCss = css(LOGO_DATA_URL);

  it("rewrites stylesheet url()s in inlined stylesheets, style text and style attributes", () => {
    const snapshot = {
      type: 2,
      timestamp: 1,
      data: {
        node: {
          type: 0,
          childNodes: [
            // An inlined <link rel="stylesheet">.
            { type: 2, tagName: "link", attributes: { _cssText: css(`${HOST}/logo.svg`) }, id: 2 },
            // A <style> (Vite's JS-imported CSS) and its text.
            {
              type: 2,
              tagName: "style",
              attributes: {},
              id: 3,
              childNodes: [{ type: 3, textContent: css(`${HOST}/logo.svg`), id: 4 }],
            },
            {
              type: 2,
              tagName: "div",
              attributes: { style: `background: url("${HOST}/logo.svg") no-repeat;` },
              id: 5,
            },
          ],
        },
      },
    };

    const [, result] = withRecordedDevServerUrls(
      asEvents(meta, snapshot),
      readWorkspaceFile,
    ) as unknown as [unknown, typeof snapshot];

    const [link, style, div] = result.data.node.childNodes;
    expect(link.attributes._cssText).toBe(resolvedCss);
    expect(style.childNodes?.[0].textContent).toBe(resolvedCss);
    expect(div.attributes.style).toBe(`background: url("${LOGO_DATA_URL}") no-repeat;`);
  });

  it("rewrites stylesheet url()s in swapped links, replaced style text and style changes", () => {
    const mutation = {
      type: 3,
      timestamp: 2,
      data: {
        source: 0,
        removes: [],
        adds: [
          {
            parentId: 3,
            nextId: null,
            node: { type: 3, textContent: css(`${HOST}/logo.svg`), id: 8 },
          },
        ],
        texts: [{ id: 4, value: css(`${HOST}/logo.svg`) }],
        attributes: [
          // Vite's link-mode HMR: the new <link> is inlined once it loads.
          { id: 9, attributes: { _cssText: css(`${HOST}/logo.svg`) } },
          { id: 10, attributes: { style: `background: url("${HOST}/logo.svg")` } },
          {
            id: 11,
            attributes: {
              style: {
                "background-image": `url("${HOST}/logo.svg")`,
                mask: [`url("${HOST}/logo.svg")`, "important"],
                color: "red",
              },
            },
          },
        ],
      },
    };

    const [, result] = withRecordedDevServerUrls(
      asEvents(meta, mutation),
      readWorkspaceFile,
    ) as unknown as [unknown, typeof mutation];

    expect(result.data.adds[0].node.textContent).toBe(resolvedCss);
    expect(result.data.texts[0].value).toBe(resolvedCss);
    expect(result.data.attributes[0].attributes._cssText).toBe(resolvedCss);
    expect(result.data.attributes[1].attributes.style).toBe(`background: url("${LOGO_DATA_URL}")`);
    expect(result.data.attributes[2].attributes.style).toEqual({
      "background-image": `url("${LOGO_DATA_URL}")`,
      mask: [`url("${LOGO_DATA_URL}")`, "important"],
      color: "red",
    });
    // The recording's own event is left as it was.
    expect(mutation.data.texts[0].value).toBe(css(`${HOST}/logo.svg`));
  });

  it("keeps the fragment that picks an icon out of an SVG sprite", () => {
    const sprite = (icon: string) =>
      `.${icon} { background-image: url("${HOST}/logo.svg#${icon}"); }`;
    const snapshot = {
      type: 2,
      timestamp: 1,
      data: {
        node: {
          type: 0,
          childNodes: [
            {
              type: 2,
              tagName: "style",
              attributes: { _cssText: sprite("check") + sprite("x") },
              id: 3,
              childNodes: [],
            },
          ],
        },
      },
    };

    const [, result] = withRecordedDevServerUrls(
      asEvents(meta, snapshot),
      readWorkspaceFile,
    ) as unknown as [unknown, typeof snapshot];

    expect(result.data.node.childNodes[0].attributes._cssText).toBe(
      `.check { background-image: url("${LOGO_DATA_URL}#check"); }` +
        `.x { background-image: url("${LOGO_DATA_URL}#x"); }`,
    );
  });

  it("leaves stylesheet url()s the workspace cannot answer alone", () => {
    const mutation = {
      type: 3,
      timestamp: 2,
      data: {
        source: 0,
        removes: [],
        adds: [],
        texts: [{ id: 4, value: `@font-face { src: url("${HOST}/font.woff2"); }` }],
        attributes: [{ id: 9, attributes: { _cssText: css(`${HOST}/missing.svg`) } }],
      },
    };
    const events = asEvents(meta, mutation);

    expect(withRecordedDevServerUrls(events, readWorkspaceFile)[1]).toBe(events[1]);
  });

  // Vite's link-mode CSS HMR: each edit adds a fresh <link href="…?t=…">, and
  // rrweb inlines it as a `_cssText` change once it loads.
  const pendingLink = (href: string, rel = "stylesheet", id = 10) => ({
    type: 2,
    tagName: "link",
    attributes: { rel, href },
    childNodes: [],
    id,
  });
  const linkSwap = <SerializedNode extends object>(...nodes: SerializedNode[]) => ({
    type: 3,
    timestamp: 2,
    data: {
      source: 0,
      texts: [],
      removes: [],
      attributes: [],
      adds: nodes.map((node) => ({ parentId: 3, nextId: null, node })),
    },
  });

  it("drops the dead dev-server href of a stylesheet link rrweb has yet to inline", () => {
    const mutation = linkSwap(pendingLink(`${HOST}/styles.css?t=1`));
    const events = asEvents(meta, mutation);

    const [, result] = withRecordedDevServerUrls(events, readWorkspaceFile) as unknown as [
      unknown,
      typeof mutation,
    ];

    expect(result.data.adds[0].node.attributes).toEqual({ rel: "stylesheet" });
    expect(mutation.data.adds[0].node.attributes.href).toBe(`${HOST}/styles.css?t=1`);
  });

  it("keeps links replay can still load or that are no stylesheet", () => {
    const events = asEvents(
      meta,
      linkSwap(
        pendingLink("https://fonts.example.com/css?family=Inter", "stylesheet", 10),
        pendingLink(`${HOST}/favicon.svg`, "icon", 11),
      ),
    );

    expect(withRecordedDevServerUrls(events, readWorkspaceFile)[1]).toBe(events[1]);
  });

  it("still replays the swapped stylesheet once rrweb inlines it", () => {
    const snapshot = {
      type: 2,
      timestamp: 1,
      data: {
        initialOffset: { top: 0, left: 0 },
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              tagName: "html",
              attributes: {},
              id: 2,
              childNodes: [
                { type: 2, tagName: "head", attributes: {}, childNodes: [], id: 3 },
                { type: 2, tagName: "body", attributes: {}, childNodes: [], id: 4 },
              ],
            },
          ],
        },
      },
    };
    const inlined = {
      type: 3,
      timestamp: 3,
      data: {
        source: 0,
        texts: [],
        removes: [],
        adds: [],
        attributes: [{ id: 10, attributes: { _cssText: ".card { color: rgb(1, 2, 3); }" } }],
      },
    };
    const events = withRecordedDevServerUrls(
      asEvents(meta, snapshot, linkSwap(pendingLink(`${HOST}/styles.css?t=1`)), inlined),
      readWorkspaceFile,
    );
    const root = document.createElement("div");
    document.body.append(root);
    // UNSAFE_replayCanvas skips rrweb's sandboxed-frame guard, which jsdom
    // cannot satisfy (see rrwebRoundTrip.test.ts).
    const replayer = new Replayer(events, {
      root,
      showWarning: false,
      useVirtualDom: false,
      UNSAFE_replayCanvas: true,
    });

    try {
      const head = () => root.querySelector("iframe")?.contentDocument?.head;
      // rrweb casts the events before the offset: here, up to the link swap.
      replayer.pause(3);
      expect(head()?.querySelector("link")?.hasAttribute("href")).toBe(false);
      replayer.pause(10);
      expect(head()?.querySelector("link")).toBeNull();
      expect(head()?.querySelector("style")?.textContent).toContain("rgb(1, 2, 3)");
    } finally {
      replayer.destroy();
      root.remove();
    }
  });
});
