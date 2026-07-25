import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hydrate, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Lesson } from "../../../tube/src/types";
import {
  buildLessonJsonLd,
  injectLessonDocument,
  QUERY_STATE_ELEMENT_ID,
  renderLessonDetailResponse,
  renderMissingLessonResponse,
  toIsoDuration,
} from "./lessonDetail";

const INDEX_HTML = readFileSync(
  fileURLToPath(new URL("../../../index.html", import.meta.url)),
  "utf8",
);

const LESSON: Lesson = {
  slug: "rust-ownership",
  title: "Ownership & Borrowing",
  description: 'Move semantics, borrows, and the "why" behind the borrow checker.',
  thumbnail: "media/lessons/abc/thumb.webp",
  ne: "media/lessons/abc/lesson.ne",
  duration: "12:30",
  tags: ["rust", "memory"],
  author: "Chan Nyein Tun",
  authorUrl: "/learn/@chan",
  publishedAt: "2026-07-20",
};

const CONTEXT = { lesson: LESSON, slug: LESSON.slug, origin: "https://nexteditor.dev" };

function readQueryState(document: string): unknown {
  const match = new RegExp(
    `<script type="application/json" id="${QUERY_STATE_ELEMENT_ID}">([\\s\\S]*?)</script>`,
  ).exec(document);
  if (!match) throw new Error("no dehydrated query state in document");
  return JSON.parse(match[1]);
}

describe("lesson detail SSR", () => {
  it("treats $-substitution patterns in lesson text as literals, not replacements", () => {
    // `$'` and `` $` `` are substitution patterns when a replacement is passed
    // to String.replace as a string, and the HTML escapers deliberately do not
    // touch `$`. Title and description are attacker-authored and uncapped, and
    // injectLessonDocument runs eight sequential rewrites over each other's
    // output — so this expanded multiplicatively and could kill the isolate.
    const document = injectLessonDocument(INDEX_HTML, {
      ...CONTEXT,
      lesson: { ...LESSON, title: "$'$'$'$'", description: "$`$`$`$`" },
    });

    expect(document).toContain("<title>$'$'$'$' | Next Editor</title>");
    expect(document).toContain('<meta name="description" content="$`$`$`$`" />');
    // The real signal: no runaway growth. The shell is ~4.6 KB and the injected
    // metadata adds well under 4 KB; anything near the shell's own size means a
    // substitution pattern expanded instead of being copied literally.
    expect(document.length).toBeLessThan(INDEX_HTML.length + 4096);
  });

  it("treats $-substitution patterns in an unknown slug as literals", async () => {
    // Reachable with no account and no lesson: any GET /learn/<anything>.
    const slug = "$`".repeat(64);
    const response = await renderMissingLessonResponse(
      new Response(INDEX_HTML, { headers: { "content-type": "text/html" } }),
      slug,
    );
    const body = await response.text();

    expect(body.length).toBeLessThan(INDEX_HTML.length + 4096);
  });

  it("replaces the shell's generic metadata against the real index.html", () => {
    const document = injectLessonDocument(INDEX_HTML, CONTEXT);

    expect(document).toContain("<title>Ownership &amp; Borrowing | Next Editor</title>");
    expect(document).toContain(
      '<meta name="description" content="Move semantics, borrows, and the &quot;why&quot; behind the borrow checker." />',
    );
    expect(document).toContain(
      '<link rel="canonical" href="https://nexteditor.dev/learn/rust-ownership" />',
    );
    expect(document).toContain('<meta property="og:type" content="article" />');
    expect(document).toContain(
      '<meta property="og:url" content="https://nexteditor.dev/learn/rust-ownership" />',
    );
    expect(document).toContain(
      '<meta property="og:image" content="https://nexteditor.dev/media/lessons/abc/thumb.webp" />',
    );
    expect(document).toContain('<meta property="og:image:type" content="image/webp" />');
    expect(document).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(document).toContain('<meta name="twitter:title" content="Ownership &amp; Borrowing" />');

    // Nothing generic may survive: the shell's own copy would otherwise
    // compete with the lesson's in the same document.
    expect(document).not.toContain("Next Editor | Interactive Code Recording &amp; Replay");
    expect(document).not.toContain('content="https://nexteditor.dev/logo.png"');
    expect(document).not.toContain('property="og:image:width"');
    expect(document).not.toContain('property="og:image:height"');
    expect(document).not.toContain('<link rel="canonical" href="https://nexteditor.dev/" />');
  });

  it("leaves the root empty for the browser to mount into", () => {
    // The editor is Monaco + WebContainers: SSR here is data and metadata only.
    expect(injectLessonDocument(INDEX_HTML, CONTEXT)).toContain('<div id="root"></div>');
  });

  it("emits a query state the browser hydrates into a ready lesson query", () => {
    const document = injectLessonDocument(INDEX_HTML, CONTEXT);

    const queryClient = new QueryClient();
    hydrate(queryClient, readQueryState(document));

    // The exact key useLesson() builds — a mismatch here means the client
    // refetches on every direct visit and the whole round trip is wasted.
    expect(queryClient.getQueryData(["lessons", "detail", "rust-ownership"])).toEqual(LESSON);
    expect(queryClient.getQueryState(["lessons", "detail", "rust-ownership"])?.status).toBe(
      "success",
    );
  });

  it("keys the query on the requested slug, not the resolved row", () => {
    const document = injectLessonDocument(INDEX_HTML, { ...CONTEXT, slug: "requested-slug" });

    const queryClient = new QueryClient();
    hydrate(queryClient, readQueryState(document));

    expect(queryClient.getQueryData(["lessons", "detail", "requested-slug"])).toEqual(LESSON);
  });

  it("neutralizes a closing script tag hidden in lesson text", () => {
    const document = injectLessonDocument(INDEX_HTML, {
      ...CONTEXT,
      lesson: { ...LESSON, description: "</script><img src=x onerror=alert(1)>" },
    });

    expect(document).not.toContain("</script><img");
    expect(document).toContain("\\u003c/script>");

    const queryClient = new QueryClient();
    hydrate(queryClient, readQueryState(document));
    expect(
      (queryClient.getQueryData(["lessons", "detail", "rust-ownership"]) as Lesson).description,
    ).toBe("</script><img src=x onerror=alert(1)>");
  });

  it("describes the lesson as a Course for rich results", () => {
    const jsonLd = buildLessonJsonLd(LESSON, "https://nexteditor.dev", "https://nexteditor.dev/x");

    expect(jsonLd).toMatchObject({
      "@type": "Course",
      name: "Ownership & Borrowing",
      keywords: "rust, memory",
      datePublished: "2026-07-20",
      author: { "@type": "Person", name: "Chan Nyein Tun" },
      hasCourseInstance: { courseMode: "online", courseWorkload: "PT12M30S" },
    });
  });

  it("converts clock durations and drops unparseable ones", () => {
    expect(toIsoDuration("4:12")).toBe("PT4M12S");
    expect(toIsoDuration("1:02:03")).toBe("PT1H2M3S");
    expect(toIsoDuration("0:45")).toBe("PT45S");
    expect(toIsoDuration("about 5 min")).toBeNull();
    expect(toIsoDuration(undefined)).toBeNull();
  });

  it("drops stale representation headers from the rewritten document", async () => {
    const response = await renderLessonDetailResponse(
      new Response(INDEX_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"static-index"',
          "last-modified": "Fri, 17 Jul 2026 00:00:00 GMT",
        },
      }),
      CONTEXT,
    );

    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("last-modified")).toBeNull();
    await expect(response.text()).resolves.toContain("Ownership &amp; Borrowing");
  });

  it("preserves non-HTML asset responses", async () => {
    const assetResponse = new Response("not html", { headers: { "content-type": "text/plain" } });

    await expect(renderLessonDetailResponse(assetResponse, CONTEXT)).resolves.toBe(assetResponse);
    await expect(renderMissingLessonResponse(assetResponse, "gone")).resolves.toBe(assetResponse);
  });

  it("serves an unknown slug as a noindex 404 shell that already knows it's missing", async () => {
    const response = await renderMissingLessonResponse(
      new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "gone",
    );
    const document = await response.text();

    expect(response.status).toBe(404);
    expect(document).toContain('<meta name="robots" content="noindex,follow" />');
    // Still the SPA shell, so the client renders its own "Lesson not found".
    expect(document).toContain('<div id="root"></div>');

    // null is findLessonBySlug()'s "no such lesson" — dehydrating it means the
    // client renders that verdict without repeating the lookup.
    const queryClient = new QueryClient();
    hydrate(queryClient, readQueryState(document));
    expect(queryClient.getQueryState(["lessons", "detail", "gone"])?.status).toBe("success");
    expect(queryClient.getQueryData(["lessons", "detail", "gone"])).toBeNull();
  });
});
