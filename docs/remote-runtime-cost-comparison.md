# Remote Runtime Provider Cost Comparison

Status: pricing survey; Cloudflare remains selected, no provider decision changes here

This document records a cost comparison of sandbox/runtime providers for the remote-runtime
effort, covering the providers listed in the
[Upstash sandbox-provider overview](https://upstash.com/blog/best-sandbox-providers-for-ai-agents)
plus WebContainers (the current default runtime). It complements
[Remote Runtime Provider Alternatives](./remote-runtime-alternatives.md), which assesses
integration capability rather than cost, and does not change the decisions recorded there.

Pricing was checked on 2026-07-18 against each vendor's published pricing page and must be
verified again before any provider decision or production purchase.

## Structural difference: client-side vs server-side compute

WebContainers is the only client-side option: Node.js runs inside the end user's browser tab, so
infrastructure cost is $0 per session at any scale. The costs are licensing and capability:

- Free for open source, non-commercial use, and prototypes/POCs.
- Commercial production use requires a paid license with no published price (contact StackBlitz
  sales).
- JavaScript/TypeScript/Node.js only; no Python, Docker, or native binaries.
- Browser memory ceilings (see the mobile Safari OOM incident on the landing page) and
  COOP/COEP header requirements.

Every alternative is server-side compute, so cost scales with session-hours. For this product's
workload — long editor preview sessions that are roughly 90% idle with CPU bursts on save — the
decisive pricing property is the billing model:

- **Provisioned billing** (E2B, Daytona, Modal, Runloop, Northflank, Fly Machines) charges the
  same whether the learner is typing or reading.
- **Active-CPU billing** (Cloudflare, Upstash Box, Vercel, Fly Sprites) meters CPU only when code
  actually runs, though some still bill provisioned memory for the full session.

## Normalized rates (checked 2026-07-18)

| Provider              | vCPU / hr                                                               | Memory / GB·hr                            | Idle billing                                            | Platform fee                      | Free tier / credits                                       | Session cap             |
| --------------------- | ----------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------- | --------------------------------- | --------------------------------------------------------- | ----------------------- |
| WebContainers         | $0 (client-side)                                                        | —                                         | —                                                       | Commercial license, unpublished   | Free for OSS                                              | Browser tab lifetime    |
| Cloudflare Containers | $0.072 (actual usage only)                                              | $0.009 provisioned, + $0.00025/GB·hr disk | Memory+disk while awake; sleeps on idle                 | $5/mo Workers Paid                | 6.25 vCPU-hr + 25 GiB-hr/mo included, 1 TB egress         | None (sleep/wake)       |
| Upstash Box           | $0.10–0.40 per active CPU-hr per box (Small 2 vCPU/4 GB = $0.10)        | Bundled                                   | None (active CPU only); keep-alive flat $8–32/mo        | $0                                | 10 boxes, 5 CPU-hr/mo                                     | 6 h idle timeout        |
| Vercel Sandbox        | $0.128 (active CPU only)                                                | $0.0212 provisioned                       | Memory billed while running; network $0.15/GB           | Pro $20/mo (credit-covered)       | Hobby: 5 CPU-hr + 420 GB-hr/mo, 45 min cap, 10 concurrent | 24 h (Pro)              |
| Northflank            | $0.01667                                                                | $0.00833                                  | Billed while running                                    | $0                                | Small free dev tier                                       | None                    |
| Daytona               | $0.0504                                                                 | $0.0162                                   | Billed while running; stopped = storage only            | $0                                | $200 credits                                              | None; sub-90 ms starts  |
| E2B                   | $0.0504                                                                 | $0.0162                                   | Billed while running                                    | $0 Hobby / $150/mo Pro            | $100 one-time credit                                      | 1 h Hobby, 24 h Pro     |
| Modal (sandbox rates) | ~$0.071 (half of $0.1419/physical core)                                 | $0.024                                    | Billed while running (~3× Modal's normal compute rate)  | $0 Starter / $250 Team            | $30/mo credits                                            | —                       |
| Runloop               | $0.108                                                                  | $0.0252                                   | Billed while running; 25 ms resume requires Pro $250/mo | $0 Basic                          | $50 credits                                               | —                       |
| Fly.io Machines       | ~$0.015/hr all-in for shared-1x + 2 GB                                  | Bundled; extra RAM ~$5/GB·mo              | Stopped = $0.15/GB·mo rootfs only                       | $0                                | —                                                         | None; DIY sandbox layer |
| Morph Cloud           | Not public — billed per MCU-hr, MCU = max(vCPU, RAM/4 GiB, disk/16 GiB) | —                                         | —                                                       | Tiered subscriptions, login-gated | —                                                         | —                       |

E2B and Daytona publish identical unit rates; the practical difference is E2B's $150/mo platform
fee once sessions exceed 1 hour or concurrency exceeds 20 sandboxes, while Daytona has no
platform fee.

## Estimated monthly cost at this workload shape

Ballpark for 1,000 preview-session-hours per month at roughly 1 vCPU + 2 GB nominal and ~7.5%
average CPU duty:

| Provider                                                                               | Estimated monthly cost               |
| -------------------------------------------------------------------------------------- | ------------------------------------ |
| WebContainers                                                                          | $0 + license (if/when commercial)    |
| Upstash Box (Small, active-only)                                                       | ~$8                                  |
| Fly Machines (DIY orchestration)                                                       | ~$15                                 |
| Cloudflare ("basic" ¼ vCPU/1 GiB ≈ $15 incl. $5 base; "standard-1" ½ vCPU/4 GiB ≈ $45) | ~$15–45                              |
| Northflank                                                                             | ~$33                                 |
| E2B / Daytona                                                                          | ~$83 (+$150 platform fee on E2B Pro) |
| Vercel Sandbox                                                                         | ~$100 (provisioned memory dominates) |
| Modal                                                                                  | ~$120                                |
| Runloop                                                                                | ~$160                                |

The ordering is robust to the duty-cycle assumption: provisioned-billing providers charge the
same regardless of activity, while Cloudflare, Upstash Box, and Vercel only meter CPU when code
runs — and Cloudflare additionally sleeps the container between requests.

## Read on the current decision

- The selected Cloudflare backend is also the cheapest managed option for idle-heavy interactive
  sessions: no session cap (sleep/wake instead), 1 TB egress included versus Vercel's $0.15/GB
  (relevant because previews serve HTTP through exposed ports), and deployment already runs on
  Cloudflare via wrangler. The trade-off versus WebContainers is a real per-user marginal cost —
  which buys multi-language support, the limitation being left behind.
- If a commercial WebContainers license becomes the blocker, the comparison is license fee versus
  ~$15–45 per 1,000 session-hours. At small scale the Cloudflare path is likely cheaper than a
  commercial license; at very large scale client-side compute wins again.
- Upstash Box is the cheapest on paper but is explicitly in developer preview ("APIs and pricing
  may change") — see the adoption gate in
  [Remote Runtime Provider Alternatives](./remote-runtime-alternatives.md). Morph does not
  publish prices at all.

## Caveats

- Modal bills per physical core (2 vCPU); the per-vCPU figure above is a conversion.
- Fly Sprites (Fly's managed sandbox product) reportedly bills $0.07/CPU-hr + $0.044/GB·hr with
  idle free, per Northflank's comparison, not Fly's own pricing page; the Fly row above uses
  verified Machines pricing.
- Cloudflare's included monthly allowances (6.25 vCPU-hr, 25 GiB-hr memory, 200 GB-hr disk)
  slightly reduce small-scale bills; the estimates above ignore them beyond the base fee.
- The ~7.5% CPU duty cycle is an assumption, not a measurement; re-estimate with real preview
  telemetry before relying on the scenario table.

## References

- [Upstash sandbox-provider overview](https://upstash.com/blog/best-sandbox-providers-for-ai-agents)
- [E2B pricing](https://e2b.dev/pricing)
- [Daytona pricing](https://www.daytona.io/pricing)
- [Modal pricing](https://modal.com/pricing)
- [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [Vercel Sandbox pricing](https://vercel.com/docs/vercel-sandbox/pricing)
- [Upstash Box pricing](https://upstash.com/pricing/box)
- [Northflank pricing](https://northflank.com/pricing)
- [Northflank AI sandbox pricing comparison](https://northflank.com/blog/ai-sandbox-pricing)
- [Runloop pricing](https://www.runloop.ai/pricing)
- [Fly.io pricing](https://fly.io/docs/about/pricing/)
- [WebContainers enterprise licensing](https://webcontainers.io/enterprise)
- [Morph Cloud docs](https://cloud.morph.so/docs/)
