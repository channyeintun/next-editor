import type { DehydratedState } from "@tanstack/react-query";
import { SERVER_QUERY_STATE_ELEMENT_ID } from "../../../src/shared/serverQueryState";

// String helpers for the documents the Worker decorates (the lesson page, the
// gallery). String-based rather than HTMLRewriter so the renders stay
// unit-testable in the worker suite's plain node environment.

export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// `</script>` anywhere inside a JSON payload would close the tag early and turn
// the rest of the payload into markup. Escaping "<" (plus the two line
// separators older parsers choke on) keeps the payload inert and still-valid
// JSON.
export function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Every String.replace in these renders passes its replacement as a FUNCTION,
// never as a string. A replacement string honours `$&`, `` $` ``, `$'` and `$1`
// as substitution patterns, and the values spliced in (lesson titles and
// descriptions) are attacker-authored: the HTML escapers deliberately leave `$`
// alone, so a title of `$'$'$'$'` made each pass re-insert the rest of the
// document, and injectLessonDocument runs eight such passes over each other's
// output. A 12-character title reached gigabytes, which is not a throw the
// caller's try/catch can catch — the isolate is killed and takes co-resident
// requests with it. The function form has no substitution semantics at all.
export function appendToHead(document: string, html: string): string {
  return document.includes("</head>")
    ? document.replace("</head>", () => `${html}\n  </head>`)
    : document;
}

/**
 * The dehydrated React Query cache, parked where the browser picks it up
 * before its first render (hydrateServerQueryState in src/queryClient.ts).
 */
export function serverQueryStateScript(state: DehydratedState): string {
  return `<script type="application/json" id="${SERVER_QUERY_STATE_ELEMENT_ID}">${serializeForScript(state)}</script>`;
}
