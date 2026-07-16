# Observability privacy contract

PostHog may receive product-navigation analytics and sanitized application-error metadata. It must
not receive lesson or workspace content. Session replay therefore blocks the complete editor root,
and exception capture is filtered separately because DOM replay selectors do not apply to thrown
`Error` objects.

## Data classification

| Surface                                                          | Classification           | PostHog handling                                                                 |
| ---------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| Navigation chrome and coarse feature actions                     | Product telemetry        | Allowed when the event contains no user-authored values                          |
| Filenames, paths, source code, binary assets, and preview DOM    | Sensitive workspace data | Blocked from session replay; never attach to analytics events                    |
| Agent prompts, transcripts, model/tool output, and confirmations | Sensitive workspace data | Blocked from session replay; never attach to analytics or exceptions             |
| Runner, shell, console, and runtime diagnostics                  | Sensitive workspace data | Blocked from session replay; messages and breadcrumbs removed from exceptions    |
| API request paths, headers, bodies, and responses                | Sensitive request data   | Blocked from session replay; request/response properties removed from exceptions |
| Slides, drawings, captions, recordings, and playback state       | Sensitive lesson data    | Blocked from session replay; never attach authored content to analytics          |
| Credentials, tokens, cookies, and authorization headers          | Secret                   | Never capture; inputs are masked as defense in depth                             |

## Enforcement

- `Editor` owns the stable `ph-no-capture` root that contains editor, workspace, preview, agent,
  runtime, API-client, slide, whiteboard, and playback surfaces. Monaco and Excalidraw selectors
  remain as defense-in-depth coverage for legacy embeds.
- All inputs are masked globally. This does not replace the blocked root because rendered text is
  not an input.
- WebContainer preview exceptions are dropped. Other application exceptions retain only an error
  type plus URL-without-query stack locations; messages, source context, breadcrumbs, commands,
  and request/response payloads are removed.
- New analytics events must use enumerated/coarse values. Do not pass free-form labels, paths,
  URLs with queries, tool arguments, or serialized objects.

The targeted privacy regression test uses sentinel source, tool, terminal, URL, and exception
values. Changes to the editor root or exception filter must keep every sentinel outside the
resulting PostHog payload.
