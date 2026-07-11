# Observability Integration Plan

Status: **proposal — nothing implemented yet**
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

- `infra/wrangler.toml` has **no `[observability]` block** — Workers Logs and Traces are off.
- 8 unstructured `console.error` calls (cache failures, lesson insert/delete cleanup). No request
  IDs, no timing. Only live tool: `wrangler tail`.
- `run_worker_first = true` means every request — including each JS chunk and image — invokes the
  Worker (COEP/COOP headers), which multiplies observability event volume (§7). (The comment atop
  the catch-all in `infra/worker/index.ts` still describes pre-`run_worker_first` routing — stale.)

Frontend:

- **No analytics, error tracking, or RUM of any kind today.** A user hitting a broken `/code`
  session is invisible unless they report it manually.
- The `/code` page is heavy and unusual: Monaco editor, Excalidraw whiteboard, XState machines,
  WebContainers (requires `COEP: require-corp` + `COOP: same-origin` on **every** response),
  WASM dmp codec.
- Recording tech: content deltas (dmp) + whiteboard snapshots + audio via the streaming recording
  codec; **rrweb is used only to capture the runtime preview iframe** — it is not the core
  recording mechanism. The `.ne` evidence file already exists as the debugging artifact of record
  (issue-repro workflow).

## 3. Frontend constraints that shape tool choice

These are project-specific and rule tools in or out before features do:

1. **Cross-origin isolation (COEP/COOP).** Third-party SDKs must be **npm-bundled**. SDKs that
   lazy-load scripts from their CDN at runtime (e.g. posthog-js lazy-loads its session-replay
   recorder by default) will be blocked under `COEP: require-corp` unless the CDN serves CORP
   headers. Mitigations exist (PostHog full-bundle import or self-hosted assets) — treat as a
   hard implementation checkpoint. Telemetry **ingestion** via `fetch` is unaffected (CORS, not
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
| **B. Native OTLP export → external backend** (dashboard-configured destination; traces+logs, no metrics, no binary OTLP; `persist=false` skips dashboard double-billing) | **Adopt when on Paid.** 10M exported events/mo included, then $0.05/M                                                                   |
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
│                                     → OTLP export → Grafana Cloud  [when on Paid]
└─ structured log middleware          (logs request ID + PostHog session ID → cross-links
                                       a PostHog session to its backend requests)
```

Cross-stack correlation note: PostHog is not a tracing backend, and Cloudflare's native tracing
doesn't yet honor incoming W3C trace context (roadmapped). Correlation is therefore **by ID
convention**: the SPA sends `X-Request-Id` (random per request) and the PostHog session ID on API
calls; the Worker logs both in its structured line. From a PostHog replay you can pull the exact
backend logs/spans; from a backend error you can find the session replay. If true distributed
tracing later becomes essential, that's the trigger to re-evaluate Sentry — or Cloudflare's trace
propagation may have shipped by then.

## 7. Phased rollout

| Phase | Track    | Cost            | What                                                                                                                                                                               |
| ----- | -------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | Backend  | $0, config-only | `[observability]` logs + traces in `infra/wrangler.toml`; deploy; watch the usage meter a week (asset-traffic multiplier, §8)                                                      |
| **1** | Frontend | $0              | PostHog via npm (full bundle — COEP checkpoint), `identify()` on login, autocapture on, ~10 custom events for the `/code` lifecycle, billing limit $0                              |
| **2** | Frontend | $0              | Session replay (sampled; paused during active lesson recording) + error tracking; decide Monaco/whiteboard masking (§9)                                                            |
| **3** | Backend  | $5/mo plan      | Workers Paid; OTLP destination → Grafana Cloud free tier (50 GB logs + 50 GB traces, 14-day retention, alerting); p95 + 5xx alerts                                                 |
| **4** | Both     | $0, small code  | Structured-log Hono middleware on `/api/*` + `/media/*` (`{route, status, durationMs, requestId, phSessionId, userId?}`); upgrade the 8 `console.error` sites to structured fields |
| **5** | Frontend | $0, custom code | Product-native `.ne` issue capture on `/code` → R2 + D1 + admin replay view                                                                                                        |
| **6** | Backend  | —               | Remote runtime: same `[observability]` on runtime Workers (DO auto-traced); Containers export OTel directly from inside the container to the same backend                          |

Phases 0–2 are independent and can all happen now on the free plan.

## 8. Cost controls

- **Backend event volume:** `run_worker_first = true` makes every static asset a Worker
  invocation → invocation log + spans each. Levers, in order: scope `run_worker_first` to route
  patterns if the COEP/COOP requirement can be met another way for static files (needs
  investigation); `invocation_logs = false`; per-signal `head_sampling_rate` last (it dilutes API
  traces too, since it's per-Worker not per-route).
- **PostHog:** autocapture on a busy SPA is chatty but 1M events/mo is roomy at current scale;
  set the billing limit to $0 (hard cap), sample replays (e.g. 100% on `/code`, 10% elsewhere),
  and drop noisy autocapture via allow/deny lists if the meter climbs.
- **Expected steady state:** $0 until Workers Paid is needed, then **$5/mo total**.

## 9. Open decisions

1. **Replay masking policy** — mask Monaco/whiteboard (privacy-safe, less useful replays) or
   record them (better debugging; users' code lands in PostHog)? Suggest: mask by default, rely
   on Phase 5 `.ne` capture — which the user explicitly triggers — for content-level repro.
2. **PostHog Cloud region** — US vs EU project (data residency; pick once, migration is manual).
3. **When to flip Workers Paid** — Phase 3 requires it; if the Containers runtime work is near,
   do Phases 0–4 in one push.
4. **Grafana Cloud confirmed as the backend sink?** Free accounts are disposable — trialing is
   cheap.
5. **Auto-capture `.ne` on unhandled `/code` errors** (upload without user action) or
   report-button only? Auto-capture is more complete but uploads user content without an explicit
   click — consent implications overlap with decision 1.

## 10. Explicit non-goals (for now)

- OTLP **metrics** export (Cloudflare doesn't support it yet; derive rates/latencies from spans).
- Log/replay archival beyond free-tier retention (Logpush→R2 later if ever needed).
- Uptime checks — a free external ping (Grafana Synthetics is in the free tier) is orthogonal;
  add with Phase 3.
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
