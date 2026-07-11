# Observability Integration Plan

Status: **implemented 2026-07-12** — all phases done except Phase 5 (product-native `.ne` issue
capture), and the paid OTLP-export phase was removed by decision. Remaining hands-on items: two
PostHog dashboard toggles (billing limit $0, "Record user sessions" ON) and a deploy to activate
Workers observability.
Scope: **two tracks** — (A) backend: the `next-editor-tube` Worker (`infra/`) and later the
remote-runtime Workers/DO/Containers; (B) frontend: user behavior, session-level tracing, and
client-side issues in the SPA, **especially `/code`**.
Written: 2026-07-11. Pricing and beta statuses are as of this date — re-verify before implementing.

## 1. Goals

- **User behavior & interaction tracing** — what users actually do in the app (feature usage,
  funnels, drop-off), with `/code` (record → edit → playback → publish) as the critical flow.
- **Issue capture** — client-side errors with enough context to reproduce: what the user did
  before the failure, session replay where useful, and (for `/code`) a real repro artifact.
- **Real-time backend request tracing** — request → Hono route → D1 / R2 / outbound fetch
  (Google APIs, Upstash REST) as OTel spans.
- **Streaming logs** — live tail while debugging + searchable recent history.
- **Low cost** — free tiers throughout; no fixed bill beyond the Workers Paid plan the Containers
  runtime will require anyway.
- **Cloudflare-compatible** — no self-hosted collectors/agents; OTel-native on the backend so the
  storage backend stays swappable.

## 2. Current state

Backend:

- **Workers Logs + Traces enabled** in `infra/wrangler.toml` (2026-07-12) — takes effect on the
  next deploy. A `requestLog` middleware emits one structured line per `/api/*`/`/media/*`
  request; error logs carry structured fields. `wrangler tail` + dashboard live tail for
  streaming.
- `run_worker_first = true` means every request — including each JS chunk and image — invokes the
  Worker (COEP/COOP headers), which multiplies observability event volume (§7). (The comment atop
  the catch-all in `infra/worker/index.ts` still describes pre-`run_worker_first` routing — stale.)

Frontend:

- **PostHog is integrated** (wizard, commit 13c3bb8): `PostHogProvider` in `src/main.tsx`,
  `identify()` on auth resolve in `AuthMenu.tsx`, 12 semantic events across landing/upload/editor,
  and `captureException` in the route error boundary (moved into an effect in 75b9f8d). The
  `VITE_PUBLIC_POSTHOG_*` vars live in the gitignored `.env` — the build machine must have them.
- **Replay + exception autocapture configured** (2026-07-12): `capture_exceptions: true`, inputs
  masked, Monaco/Excalidraw blocked, replay paused during lesson recording. Replay starts once
  "Record user sessions" is toggled ON in PostHog project settings.
- The `/code` page is heavy and unusual: Monaco editor, Excalidraw whiteboard, XState machines,
  WebContainers (requires `COEP: require-corp` + `COOP: same-origin` on **every** response),
  WASM dmp codec.
- Recording tech: content deltas (dmp) + whiteboard snapshots + audio via the streaming recording
  codec; **rrweb is used only to capture the runtime preview iframe** — it is not the core
  recording mechanism. The `.ne` evidence file already exists as the debugging artifact of record
  (issue-repro workflow).

## 3. Frontend constraints that shape tool choice

These are project-specific and rule tools in or out before features do:

1. **Cross-origin isolation (COEP/COOP).** Third-party SDKs must be **npm-bundled**, and any
   scripts they lazy-load from their CDN must survive `COEP: require-corp`. **Verified OK for
   posthog-js (2026-07-12):** it injects lazy scripts with `crossorigin="anonymous"` and the
   PostHog CDN answers with `access-control-allow-origin: *`, so CORS-mode loading satisfies COEP
   — no full-bundle import or self-hosted assets needed. Re-verify if switching SDKs or if
   PostHog's asset CDN changes. Telemetry **ingestion** via `fetch` is unaffected (CORS, not
   CORP).
2. **Session-replay tools are page-level rrweb recorders** (PostHog Replay and Sentry Replay are
   both rrweb-based). On `/code` that means observing the Monaco DOM (large, mutation-heavy) and
   the Excalidraw canvas (canvas capture is off by default in these tools; enabling it is
   expensive). This is independent of the product's own rrweb usage (preview iframe only), but a
   lesson-recording session already carries capture overhead — the replay tool must be sampled
   and/or paused while the user is actively recording.
3. **The WebContainer preview iframe is cross-origin** from a third-party recorder's perspective —
   it renders **blank** in their replays. Generic session replay can never fully show a `/code`
   bug; only the product-native channel can (§5, option 4).
4. **Privacy: replays capture user code.** Monaco renders code as plain DOM text (not `<input>`),
   so default input-masking does **not** hide it — masking Monaco/whiteboard requires explicit
   block-class configuration, which then reduces replay usefulness. Decide deliberately (§9).

## 4. Backend options (unchanged conclusions, summarized)

| Option                                                                                                                                                                   | Verdict                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Cloudflare native Workers Logs + Traces** (config-only; auto-spans for handlers, D1/R2/KV/DO bindings, outbound fetch — Upstash included)                           | **Adopt.** Free-plan: 200k events/day, 3-day retention. Paid: ~20M events/mo pooled, 7-day. Custom spans not yet supported (roadmapped) |
| **B. Native OTLP export → external backend** (dashboard-configured destination; traces+logs, no metrics, no binary OTLP; `persist=false` skips dashboard double-billing) | **Removed 2026-07-12** — requires Workers Paid ($5/mo); not worth it at current scale                                                   |
| **C. `@microlabs/otel-cf-workers`** (in-code OTel SDK)                                                                                                                   | Reserve — only if custom spans needed before Cloudflare ships them                                                                      |
| **D. Tail Worker forwarding**                                                                                                                                            | Rejected — custom plumbing made redundant by B                                                                                          |
| **E. Workers Logpush**                                                                                                                                                   | Rejected — batch, no tracing; maybe future R2 log archival                                                                              |
| **F. Self-hosted backend (SigNoz/LGTM)**                                                                                                                                 | Rejected — needs a server; violates Cloudflare-only constraint                                                                          |

Streaming logs stay free and real-time on all plans via `wrangler tail` + dashboard live tail.

## 5. Frontend options

### Option 1 — PostHog (recommended)

Product analytics + session replay + error tracking in one npm SDK, with the most generous free
tier in the category: **1M events, 5k session replays, 100k exceptions per month, free forever**,
plus funnels, retention, and feature flags. Billing limits can be pinned to $0 so it can never
surprise-charge.

- **Behavior:** autocapture (clicks, pageviews, rageclicks) out of the box + custom events for
  editor semantics (`recording_started`, `playback_completed`, `webcontainer_boot_failed`,
  `lesson_published`, …). `identify()` with the Google-auth user ID ties sessions to users.
- **Issues:** error tracking captures unhandled exceptions/rejections with the event trail that
  preceded them; session replay shows the UI context (minus the preview iframe, §3.3).
- **Fit caveats:** COEP bundling checkpoint (§3.1); replay sampling/pausing on `/code` during
  active recording (§3.2); Monaco masking decision (§3.4).

### Option 2 — Sentry (browser + `@sentry/cloudflare`)

Error-first, and the only option giving **true browser→Worker distributed tracing today**
(`sentry-trace` propagation both sides). But the free Developer plan is tight for this use case:
5k errors, 10k spans, **50 replays**/month, 1 user, 30-day retention — and behavior analytics
isn't what Sentry is for. Choose only if error triage with full-stack traces matters more than
behavior analytics; don't run it alongside PostHog error tracking (duplicate capture, double SDK
weight).

### Option 3 — Grafana Faro (Frontend Observability)

OTel-native RUM into the same Grafana Cloud stack as the backend (free tier: **50k sessions/mo**):
web vitals, errors, logs, browser traces that correlate with Tempo backend traces. One vendor for
everything — but **no session replay and no autocapture** (manual events only), which misses the
core ask (behavior + issue context). Reasonable fallback if consolidating on Grafana ever
outweighs replay.

### Option 4 — Product-native issue capture for `/code` (unique to this app; complements Option 1)

Generic replay can't see into the preview iframe or the editor's semantic state — but the app's
own recording pipeline can. Proposal: a "Report a problem" action + automatic capture on
unhandled error within `/code` that assembles the existing evidence format — the **`.ne` bundle**
(content deltas, whiteboard snapshots, preview rrweb channel) plus editor-machine state/version
metadata — and uploads it to R2 (`issue-reports/<id>`) with a D1 row. Replayable with the
product's own player; matches the established issue-repro debugging workflow exactly.

- Cost: $0 (R2 free tier), no third party, no consent complexity beyond an explicit user action.
- Effort: custom code (capture assembly, upload route, list/replay admin view) — the only option
  here that isn't config + SDK.
- Scope: `/code` only, repro-depth only — it does not replace behavior analytics.

## 6. Recommended architecture

```
Browser (SPA)
├─ PostHog SDK (npm-bundled)          → PostHog Cloud   [behavior, replay, client errors]
├─ /code error boundary / report btn  → R2 + D1         [.ne issue bundles, product player]
└─ apiClient fetch (+ request ID, session ID headers)
        │
        ▼
Worker (next-editor-tube)
├─ [observability] logs + traces      → CF dashboard    [auto-spans: D1/R2/fetch; live tail]
└─ structured log middleware          (logs PostHog session/distinct IDs → cross-links
                                       a PostHog session to its backend requests)
```

The OTLP-export → Grafana Cloud leg was **dropped 2026-07-12** (Chan's call: not worth the $5/mo
Workers Paid prerequisite at current scale). The backend story is the Cloudflare dashboard on the
free plan: 200k events/day, 3-day retention, live tail. If retention/alerting ever bites, the
export design lives in git history and slots back in without code changes.

Cross-stack correlation: PostHog is not a tracing backend, and Cloudflare's native tracing
doesn't yet honor incoming W3C trace context (roadmapped). Correlation is therefore **by ID
convention**, and both halves are wired: the SPA stamps `X-POSTHOG-SESSION-ID` /
`X-POSTHOG-DISTINCT-ID` on same-host fetches (`__add_tracing_headers` in `src/main.tsx`), and the
Worker's `requestLog` middleware logs them with route/status/duration. From a PostHog replay you
can pull the exact backend logs/spans; from a backend error you can find the session replay. If
true distributed tracing later becomes essential, that's the trigger to re-evaluate Sentry — or
Cloudflare's trace propagation may have shipped by then.

## 7. Phased rollout

| Phase | Track    | Cost            | What                                                                                                                                                                                                                                                                                              |
| ----- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | Backend  | $0, config-only | ✅ **Done 2026-07-12**: `[observability]` logs + traces in `infra/wrangler.toml`. Activates on next deploy; watch the usage meter a week (asset-traffic multiplier, §8)                                                                                                                           |
| **1** | Frontend | $0              | ✅ **Done** (13c3bb8, 75b9f8d): PostHog via npm, `identify()` on login, 12 custom events, error boundary capture. Remaining: pin billing limit to $0 in the PostHog dashboard; add `.env.example`; source-map upload for de-minified prod stack traces                                            |
| **2** | Frontend | $0              | ✅ **Done 2026-07-12** (client side): `capture_exceptions: true`; replay masking (`maskAllInputs` + block `.monaco-editor`/`.excalidraw`); replay paused during active lesson recording. Remaining: flip "Record user sessions" ON in PostHog project settings — replay does not start without it |
| ~~3~~ | Backend  | ~~$5/mo~~       | **Removed 2026-07-12** — was Workers Paid + OTLP export → Grafana Cloud. Not worth the fixed cost at current scale; free-plan dashboard suffices. Resurrect from git history if export/retention/alerting is ever needed                                                                          |
| **4** | Both     | $0, small code  | ✅ **Done 2026-07-12**: `requestLog` middleware on `/api/*` + `/media/*` (`{method, path, status, durationMs, phSessionId, phDistinctId}`); the 5 `console.error` sites with positional IDs now log structured fields                                                                             |
| **5** | Frontend | $0, custom code | Product-native `.ne` issue capture on `/code` → R2 + D1 + admin replay view. **Only remaining build item** — blocked on decision §9.5 (report-button vs auto-capture) and needs its own UX pass                                                                                                   |
| **6** | Backend  | —               | Remote runtime: same `[observability]` on runtime Workers (DO auto-traced); Containers ship logs to the CF dashboard (`observability` in the container Worker config)                                                                                                                             |

Everything except Phase 5 is done and free. Backend observability activates on the next
`bun run build` + `wrangler deploy --config infra/wrangler.toml`.

## 8. Cost controls

- **Backend event volume:** `run_worker_first = true` makes every static asset a Worker
  invocation → invocation log + spans each. Levers, in order: scope `run_worker_first` to route
  patterns if the COEP/COOP requirement can be met another way for static files (needs
  investigation); `invocation_logs = false`; per-signal `head_sampling_rate` last (it dilutes API
  traces too, since it's per-Worker not per-route).
- **PostHog:** autocapture on a busy SPA is chatty but 1M events/mo is roomy at current scale;
  set the billing limit to $0 (hard cap), sample replays in project settings if the 5k/mo meter
  climbs, and drop noisy autocapture via allow/deny lists if the event meter climbs.
- **Expected steady state:** **$0** (both Cloudflare and PostHog inside free tiers).

## 9. Decisions

1. **Replay masking policy — RESOLVED (2026-07-12): mask by default.** `maskAllInputs: true` and
   `blockSelector: ".monaco-editor, .excalidraw"` in `src/main.tsx`; users' code and drawings
   never reach PostHog. Content-level repro is Phase 5's job (explicitly user-triggered).
2. **PostHog Cloud region — RESOLVED: US** (project created on us.posthog.com by the wizard).
3. ~~When to flip Workers Paid~~ — moot; the paid phase was removed. Revisit only when the
   Containers runtime lands (which forces Paid anyway).
4. ~~Grafana Cloud as backend sink~~ — moot; export phase removed.
5. **OPEN: `.ne` capture trigger for Phase 5** — report-button only (explicit consent, suggested)
   vs auto-capture on unhandled `/code` errors (more complete, uploads user content without a
   click).

## 10. Explicit non-goals (for now)

- OTLP **metrics** export (Cloudflare doesn't support it yet; derive rates/latencies from spans).
- Log/replay archival beyond free-tier retention (Logpush→R2 later if ever needed).
- Uptime checks — a free external ping (e.g. UptimeRobot, Grafana Synthetics free tier) is
  orthogonal; add anytime.
- A/B testing / feature-flag rollout tooling (PostHog has it free if wanted later — not part of
  this plan).

## Sources

Backend: [Workers Observability](https://developers.cloudflare.com/workers/observability/) ·
[Workers Traces](https://developers.cloudflare.com/workers/observability/traces/) ·
[Exporting OpenTelemetry data](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/) ·
[tracing beta announcement](https://blog.cloudflare.com/workers-tracing-now-in-open-beta/) ·
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) ·
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) ·
[Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/) ·
[Workers Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/)

Frontend: [PostHog pricing](https://posthog.com/pricing) ·
[PostHog session replay troubleshooting](https://posthog.com/docs/session-replay/troubleshooting) ·
[Sentry pricing](https://sentry.io/pricing/) ·
[Grafana Frontend Observability](https://grafana.com/products/cloud/frontend-observability/) ·
[Faro Web SDK](https://github.com/grafana/faro-web-sdk)

Backends: [Grafana Cloud free tier](https://grafana.com/products/cloud/free-tier/) ·
[Honeycomb pricing](https://www.honeycomb.io/pricing) ·
[Axiom pricing](https://axiom.co/pricing)
