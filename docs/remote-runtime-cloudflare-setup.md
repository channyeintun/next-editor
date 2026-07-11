# Remote Runtime — manual Cloudflare dashboard setup guide

**Companion docs:** [remote-runtime-design.md](./remote-runtime-design.md) (§9–§10) ·
[remote-runtime-implementation-plan.md](./remote-runtime-implementation-plan.md) (Phase 4)

This guide covers the **one-time, manual account/dashboard work** that `wrangler deploy`
cannot do for you. Everything else (Worker code, Durable Object bindings + migrations,
container image build & push, routes declared in `wrangler.toml`) is automated by wrangler
and belongs to Phase 4 of the implementation plan — don't do those by hand.

Facts marked ✅ were verified against Cloudflare docs on **2026-07-11**. Dashboard navigation
paths are approximate (the UI moves); the setting names are the stable part.

---

## 0. Manual vs automated — know what NOT to click

| Concern                                       | Manual (this guide)            | Automated by wrangler |
| --------------------------------------------- | ------------------------------ | --------------------- |
| Billing plan / Containers access              | ✅ Step 1                      | —                     |
| Preview hostname scheme + DNS records         | ✅ Steps 2–3                   | —                     |
| TLS certificates (only if multi-level scheme) | ✅ Step 4                      | —                     |
| Worker routes                                 | — (declare in `wrangler.toml`) | ✅ created on deploy  |
| DO namespace, bindings, migrations            | —                              | ✅ on deploy          |
| Container image build/push, rollouts          | — (Docker must be running)     | ✅ on deploy          |
| API token for CI                              | ✅ Step 5                      | —                     |
| Worker secrets                                | ✅ Step 6 (CLI)                | —                     |
| D1 quota tables (remote migration)            | ✅ Step 7 (CLI, explicit)      | local only            |
| Post-deploy checks, image storage hygiene     | ✅ Step 8                      | —                     |
| Spend alerts / observability                  | ✅ Step 9 (optional)           | —                     |

---

## 1. Billing: Workers Paid plan (required for Containers)

✅ Containers require the **Workers Paid plan ($5/month)**. Durable Objects (the
SQLite-backed classes we use) also come with it.

1. <https://dash.cloudflare.com> → select the account that owns the current worker deploy
   (the one `infra/wrangler.toml` targets).
2. Left sidebar → **Billing** (or **Manage account → Billing**) → **Subscriptions** →
   under _Workers_, upgrade **Free → Paid**.
3. Verify Containers are available: sidebar → **Compute (Workers & Pages)** → a
   **Containers** entry should be visible. If the account is brand new it may show an
   onboarding/enable screen — accept it.

Included monthly usage on the paid plan (overage billed per-use, ✅ rates as of 2026-07):
25 GiB-hours memory, 375 vCPU-minutes, 200 GB-hours disk, 500 GB–1 TB egress depending on
region. See Step 9 for cost guardrails.

---

## 2. Decide the preview hostname scheme (do this BEFORE touching DNS)

The preview ingress (design §8.1) serves user dev-servers at per-session URLs. The URL shape
determines your DNS + TLS work, because of one rule:

> ✅ **Universal SSL covers only `example.com` and first-level subdomains
> (`*.example.com`). Deeper names like `p8080-abc.preview.example.com` get NO valid
> certificate** unless you buy Advanced Certificate Manager (ACM) or upload a custom cert.

Pick one:

| Option                                                                | previewUrlTemplate                                    | DNS needed                                                       | TLS cost                                    | Notes                                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A (recommended): separate cheap domain** e.g. `yourapp-preview.com` | `https://p{{port}}-{{sessionId}}.yourapp-preview.com` | 1 wildcard record on the new zone                                | free (Universal SSL `*` covers first level) | Best security: user content lives on a different registrable domain — preview pages can never set/read cookies scoped to your app domain. This is why StackBlitz uses `webcontainer-api.io`. Costs one domain registration. |
| **B: same zone, single-level**                                        | `https://p{{port}}-{{sessionId}}-preview.example.com` | 1 wildcard record `*` on your zone (only if not already present) | free                                        | Zero extra spend. Weaker isolation: previews are siblings of your app (the ingress already strips cookies, and user JS could still set `Domain=example.com` cookies — known tradeoff).                                      |
| **C: same zone, multi-level (`*.preview.example.com`)**               | `https://p{{port}}-{{sessionId}}.preview.example.com` | wildcard record `*.preview`                                      | **paid** — requires ACM add-on              | Matches the design doc's illustrative URL, but costs a monthly add-on for no functional gain over A/B. Only pick if you want the tidy namespace.                                                                            |

> The template is server-configuration (returned by `POST /sessions`, design §5.1), so this
> choice touches no client code. **Record your choice in `infra/wrangler.toml` comments** so
> implementing agents use the same shape in the ingress host-parsing code.

> **No custom domain at all (workers.dev only)?** Host-based previews are impossible —
> there are no wildcard `workers.dev` hostnames. Use the path-based routing mode
> (`/preview/:sessionId/:port/*`, design §8.1) in production too and skip Steps 3–4. Known
> limitation: apps emitting absolute-path asset URLs may misbehave.

---

## 3. DNS records (dashboard)

Worker routes do **not** create DNS records — the hostname must resolve and be proxied for
the route to ever match. Create a proxied placeholder record:

1. Dashboard → your zone → **DNS → Records** → **Add record**.
2. Per your Step-2 choice:
   - **Option A** (on the new preview zone): Type `AAAA`, Name `*`, Content `100::`,
     Proxy status **Proxied** (orange cloud).
   - **Option B**: Type `AAAA`, Name `*`, Content `100::`, **Proxied**. (Skip if the zone
     already has a proxied `*` record. A wildcard record only answers for names that have no
     explicit record, so existing subdomains are unaffected.)
   - **Option C**: Type `AAAA`, Name `*.preview`, Content `100::`, **Proxied**.

`100::` (or A `192.0.2.1`) is a standard black-hole placeholder — traffic never reaches it;
the Worker route intercepts first. ✅ Proxied wildcard records are available on all plans.

The matching Worker route goes in `infra/wrangler.toml` (Phase 4.1), e.g. for Option B:

```toml
routes = [
  { pattern = "*-preview.example.com/*", zone_name = "example.com" },
]
```

(wrangler creates/updates the route on deploy — no dashboard route work needed.)

---

## 4. TLS certificates (only for Option C — skip for A/B)

Options A and B are fully covered by the zone's free Universal SSL — verify under
**SSL/TLS → Edge Certificates** that the Universal certificate is _Active_, and do nothing
else.

For **Option C** only:

1. Zone → **SSL/TLS → Edge Certificates** → **Order Advanced Certificate** (this prompts the
   **Advanced Certificate Manager** add-on purchase — a paid monthly add-on; check the
   current price at checkout).
2. Hostnames on the certificate: `example.com`, `*.example.com`, `*.preview.example.com`.
   (One wildcard level per entry — `*.preview.example.com` covers exactly
   `p8080-abc.preview.example.com`, which is all we need.)
3. Certificate authority / validity: defaults are fine. Wait for status **Active**
   (minutes), then confirm `https://test.preview.example.com` serves a valid cert (a 404/522
   is fine — only the cert matters until the Worker route exists).

Alternative with ACM: enable **Total TLS** (SSL/TLS → Edge Certificates) to auto-issue
per-hostname certs for every proxied DNS name instead of managing the list yourself.

---

## 5. API token for CI (skip if you only deploy from your machine)

Local deploys need no token — `wrangler login` (browser OAuth) is enough.

For CI (GitHub Actions etc.):

1. Dashboard (top-right avatar) → **My Profile → API Tokens → Create Token**.
2. Start from the **Edit Cloudflare Workers** template, then adjust:
   - Scope it to _this account_ and _this zone_ only.
   - Add **Account · D1 · Edit** (quota tables, Step 7).
   - Add the Containers/registry permission so image pushes work — in the permission picker
     it appears as **Containers** (older accounts may show the internal name
     _Cloudchamber_) · **Edit**. The Workers template alone does **not** push images.
3. Create, copy once, store as a CI secret (e.g. `CLOUDFLARE_API_TOKEN`), never in the repo.
4. Sanity check locally:
   `CLOUDFLARE_API_TOKEN=… bunx wrangler whoami`.

> CI runners must also have **Docker** available — `wrangler deploy` builds the container
> image locally before pushing (✅ images must be `linux/amd64`).

---

## 6. Worker secrets (CLI, one-time per environment)

The runtime control plane needs at least one secret (design §9.2 — session/WS token
signing). Secrets are not dashboard-manual per se, but they're outside `wrangler deploy`:

```sh
cd infra
bunx wrangler secret put RUNTIME_SESSION_SECRET   # paste a 32+ byte random value
```

(Generate with `openssl rand -base64 32`.) Dashboard equivalent if you prefer clicking:
worker → **Settings → Variables and Secrets → Add → Secret**. Repeat per environment if you
add a staging worker.

---

## 7. D1: quota tables on the remote database

Phase 4.3 adds quota-counter tables via a migration. Per this repo's convention, **applying
migrations to the remote D1 is a separate, explicitly-authorized step** (never bundled into
deploy):

```sh
cd infra
bunx wrangler d1 migrations apply <DB_NAME> --remote
```

Dashboard is only for verification: **Storage & Databases → D1 →** your DB → check the new
tables exist. No manual table creation — the migration is the source of truth.

---

## 8. After the first deploy: Containers dashboard checks

Once Phase 4 code deploys (`bun run build` + `wrangler deploy` from `infra/`, with Docker
running):

1. **Compute (Workers & Pages) → Containers**: your container app appears with its image,
   instance type, and rollout status. Boot a session from the editor and watch an instance
   appear; use its **Logs** tab for agent stdout when debugging.
2. **Instance type** is set in `wrangler.toml`, not the dashboard. ✅ Current types:

   | Type       | vCPU | Memory  | Disk  |
   | ---------- | ---- | ------- | ----- |
   | lite       | 1/16 | 256 MiB | 2 GB  |
   | basic      | 1/4  | 1 GiB   | 4 GB  |
   | standard-1 | 1/2  | 4 GiB   | 8 GB  |
   | standard-2 | 1    | 6 GiB   | 12 GB |
   | standard-3 | 2    | 8 GiB   | 16 GB |
   | standard-4 | 4    | 12 GiB  | 20 GB |

   Start with **basic** for `runtime-go1.24` (Go builds are memory-hungry; `lite`'s 256 MiB
   will OOM `go build` on non-trivial projects). Measure before moving up.

3. **Image storage hygiene**: ✅ the account-wide image storage cap is **50 GB**, and each
   image must fit the instance type's disk. Old image versions accumulate on every deploy —
   periodically run `bunx wrangler containers images list` and
   `bunx wrangler containers images delete …` (or check the dashboard Containers → Images
   view). Add this to your deploy notes; hitting the cap fails deploys.
4. ✅ Account concurrency ceilings (defaults; raise via support ticket if the editor grows):
   6 TiB memory, 1,500 vCPU, 30 TB disk across all running instances — at `basic` size that
   is thousands of parallel sessions, so not a near-term concern.

---

## 9. Optional but recommended: guardrails

1. **Spend visibility**: **Billing → Notifications** (or the **Notifications** hub) → create
   a _Billing — usage threshold_ alert so container overage (memory GiB-s / vCPU-s / disk /
   egress) emails you before a surprise invoice. The app-level quotas (design §9.2, D1
   counters) are the first line of defense; this is the backstop.
2. **Workers Logs**: worker → **Settings → Observability** → enable Workers Logs (and tail
   with `bunx wrangler tail` during Phase 4 bring-up).
3. **Idle-timeout sanity**: after a day of real use, check Containers metrics for instances
   that ran far longer than editor sessions — that smells like the DO idle alarm not firing
   (plan risk register).

---

## 10. Final checklist

- [ ] Workers Paid plan active; Containers section visible in dashboard
- [ ] Preview hostname scheme chosen (A/B/C) and recorded in `infra/wrangler.toml` comments
- [ ] Proxied wildcard DNS record created (`100::` placeholder)
- [ ] TLS: Universal SSL active (A/B) — or ACM cert incl. `*.preview.example.com` active (C)
- [ ] CI API token created with Workers + D1 + Containers edit scopes (if CI deploys)
- [ ] `RUNTIME_SESSION_SECRET` set via `wrangler secret put`
- [ ] Remote D1 migration applied (explicitly, after review)
- [ ] First deploy: container instance boots, `/healthz` OK, preview URL serves with valid cert
- [ ] Billing usage notification configured
- [ ] Image-storage cleanup noted in deploy routine (50 GB account cap)
