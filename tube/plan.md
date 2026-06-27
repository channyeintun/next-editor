# NextEditor Tube — Implementation Plan

A separate, standalone website ("a YouTube for code lessons") hosted at
**`tube.nexteditor.dev`**. It is a lesson **gallery**: the home page shows
YouTube-style cards (thumbnail image only — no video, no `.ne` iframe). Clicking a
card opens the lesson in the existing NextEditor in **read-only playback mode** at
`nexteditor.dev/code`.

This project lives in the `tube/` folder of the main `next-editor` repo for
distribution convenience, but it is an **independent app** — it is not imported by
or built with the main app.

---

## 1. Goals & non-goals

**Goals**

- Static, fast, cheap-to-host gallery of recorded lessons.
- Lessons authored manually: drop a folder into `public/`, add an entry to a JSON
  manifest. No CMS, no database.
- Cards link out to the _real_ editor for playback; the tube site never embeds the
  editor or plays `.ne` itself.
- Recording stays exclusively on `nexteditor.dev/code` (no record UI here).

**Non-goals (v1)**

- No accounts, comments, likes, view counts, or uploads.
- No server / backend. Pure static hosting.
- No `.ne` parsing on this site — it only stores and links to the files.

---

## 2. The link contract (most important part)

> **Updated:** lessons open in an **embedded iframe** (see `LessonPlayer`), not by
> navigating away, and the editor is served **same-origin** via reverse proxy
> (B1 — see §9). The iframe `src` is therefore a same-origin path:

```
/code?url=<ENCODED_NE_PATH>&readOnly=true&deferRuntimeAutostart=true
```

Where `<ENCODED_NE_PATH>` is `encodeURIComponent("/lessons/<slug>/<slug>.ne")`,
e.g.:

```
/code?url=%2Flessons%2Fintroduction%2Fintroduction.ne&readOnly=true&deferRuntimeAutostart=true
```

Verified against the main app:

- `readOnly=true` → playback mode: hides import/export, disables record mode, skips
  the product tour. (`src/components/Editor.tsx`)
- `url=...` → loaded via `useUrlLoader`; relative URLs resolve against the editor's
  origin, absolute (cross-origin) URLs are fetched directly (with a `/api/proxy`
  attempt first that harmlessly falls back). (`src/hooks/useUrlQuery.ts`,
  `src/hooks/useUrlLoader.ts`)

> Optionally add `&largeControls=true` if a lesson is meant to be viewed in a
> reduced/embedded context — not needed for normal full-page playback.

---

## 3. Origin model (B1 — same-origin, no CORS)

The editor is reverse-proxied under `tube.nexteditor.dev` (see §9), so the iframe,
the editor's assets, and the `.ne`/`.vtt` files are **all same-origin**. That means:

- **No CORS** needed on `.ne`/`.vtt` — the proxied editor fetches them from this
  same origin directly.
- **Cross-origin isolation works** — `COOP: same-origin` + `COEP: require-corp` on
  the tube origin make it cross-origin isolated; a same-origin iframe inherits it,
  so WebContainer (`SharedArrayBuffer`) can boot for live run/edit.
- The only genuinely cross-origin resources are the editor's own WebContainer CDN
  calls (`*.staticblitz.com`), which already serve COEP-compatible headers (they
  work for the editor today).

> Why not a cross-origin iframe? Making a cross-origin iframe cross-origin-isolated
> requires `COEP: require-corp` + `CORP: cross-origin` on the editor **and** CORP
> on every tube subresource — brittle. Reverse-proxying side-steps all of it.

---

## 4. Lesson authoring workflow (manual)

To add a lesson:

1. Create a folder under `public/<slug>/` containing:
   - `<slug>.ne` — the recording (exported from `nexteditor.dev/code`).
   - `<slug>.<lang>.vtt` — one or more caption tracks (e.g. `introduction.en.vtt`).
   - `thumbnail.jpg` (or `.png`/`.webp`) — the card image (16:9 recommended).
2. **Make sure the `.ne` declares its captions.** Captions auto-load only if the
   recording's `captionFiles` field lists the sibling VTTs (resolved relative to the
   `.ne` URL). If a recording was exported without it, the `.vtt` won't show during
   playback. Document this clearly for authors.
   - Recommended convention: `captionFiles: ["<slug>.en.vtt"]` inside the recording.
3. Add an entry to `public/lessons.json` (see schema below).

Example tree:

```
public/
  lessons.json
  introduction/
    introduction.ne
    introduction.en.vtt
    thumbnail.jpg
  react-state/
    react-state.ne
    react-state.en.vtt
    react-state.my.vtt
    thumbnail.webp
```

---

## 5. Data model — `public/lessons.json`

Fetched at runtime (so editing the JSON needs no rebuild). Keep it a flat list.

```jsonc
{
  "lessons": [
    {
      "slug": "introduction", // matches folder name
      "title": "Introduction to NextEditor",
      "description": "A short tour of recording and playback.",
      "thumbnail": "introduction/thumbnail.jpg", // path under public/
      "ne": "introduction/introduction.ne", // path under public/
      "duration": "4:12", // optional, display-only string
      "tags": ["intro", "basics"], // optional, for filtering later
      "author": "Chan", // optional
      "publishedAt": "2026-06-28", // optional, ISO date for sorting
    },
  ],
}
```

Runtime URL construction (in the card component):

- thumbnail `src` = `/<thumbnail>` (same-origin to the tube site).
- `.ne` absolute URL = `https://tube.nexteditor.dev/<ne>` (use
  `new URL(lesson.ne, window.location.origin).toString()` so localhost works too).
- play link = `${EDITOR_BASE}/code?url=${encodeURIComponent(neAbsUrl)}&readOnly=true`
  where `EDITOR_BASE` is an env-configurable base (`https://nexteditor.dev` in prod,
  e.g. `http://localhost:5173` in dev).

---

## 6. Tech stack

Mirror the main app so the user (and Sonnet 4.6) work in a familiar setup:

- **Vite + React 19 + TypeScript**
- **Tailwind CSS v4** (`@tailwindcss/vite`)
- **react-router** (only needed if an on-site detail page is added later; v1 home is
  a single page, so router is optional)
- **bun** as package manager (repo convention — never npm/yarn/pnpm)
- **lucide-react** for icons (matches main app)

No `.ne` decoding deps, no WebContainer, no xstate — this is a thin static UI.

---

## 7. Project structure (`tube/`)

```
tube/
  plan.md                  <- this file
  package.json
  vite.config.ts
  tsconfig.json
  index.html
  .env.example             <- VITE_EDITOR_BASE=https://nexteditor.dev
  public/
    lessons.json
    favicon.png
    <slug>/...              <- lesson folders (see §4)
  src/
    main.tsx
    App.tsx
    index.css              <- tailwind import
    lib/
      lessons.ts           <- fetch + type for lessons.json
      links.ts             <- buildPlayUrl(lesson), resolveThumb(lesson)
    components/
      Header.tsx           <- logo + "Record your own →" CTA to nexteditor.dev/code
      LessonGrid.tsx       <- responsive grid of cards
      LessonCard.tsx       <- thumbnail-only YouTube-style card
      SearchBar.tsx        <- optional client-side filter (title/tags)
      Footer.tsx
    types.ts               <- Lesson type
```

---

## 8. Components

**`LessonCard`** (YouTube-style, thumbnail only)

- 16:9 thumbnail `<img loading="lazy">` with rounded corners; optional duration
  badge in the corner (from `lesson.duration`).
- Below: title (2-line clamp), author + publishedAt meta row.
- Entire card is an `<a href={playUrl} target="_blank" rel="noopener">` (or
  same-tab — decide; YouTube uses same-tab, recommend same tab).
- Hover: subtle scale/elevation, matching the main landing page's aesthetic.

**`LessonGrid`**

- `fetch('/lessons.json')` once, render cards. Responsive: 1 col mobile → 4 cols
  desktop. Loading + empty + error states.

**`Header`**

- Left: NextEditor Tube logo (reuse `logo.svg` from main `public/`).
- Right: a "Record your own →" button linking to `https://nexteditor.dev/code`
  (recording lives only there).

**`SearchBar`** (optional, nice-to-have)

- Client-side filter over title/tags. No backend.

---

## 9. Deployment — B1: reverse-proxy the editor under the tube origin

The lesson is **embedded in an iframe** (no navigating away), and the embed must
support **live run + edit** (WebContainer), which requires **cross-origin
isolation** (`COOP: same-origin` + `COEP: require-corp`, for `SharedArrayBuffer`).
A _cross-origin_ iframe can't be made isolated without fragile per-asset CORP
headers — so instead we make the editor **same-origin** with the gallery by
reverse-proxying it under `tube.nexteditor.dev`. Same-origin iframes inherit
isolation automatically, and proxied assets are delivered as this origin (so COEP
is satisfied with no CORS/CORP juggling).

> Read-only **playback** alone does _not_ need WebContainer — the preview/terminal
> replay via rrweb, and the editor already gates WebContainer auto-boot off when
> `crossOriginIsolated` is false. B1 is what additionally enables the
> run-it-yourself capability inside the embed.

Routing on `tube.nexteditor.dev` (all responses carry the isolation headers):

| Path                                        | Served by                           |
| ------------------------------------------- | ----------------------------------- |
| `/code`, `/assets/*`, `/fonts/*`, `/logo.*` | **reverse-proxy → editor upstream** |
| `/lessons/*` (`.ne`/`.vtt`/thumbnails)      | tube static (same-origin)           |
| `/gallery-assets/*` (gallery bundles)       | tube static                         |
| `/`, `/lessons.json`, `/favicon.png`        | tube static                         |

Key build/config choices that make this collision-free:

- Tube builds its bundles into **`/gallery-assets/`** (`build.assetsDir`) so they
  never shadow the editor's `/assets/*`.
- Lesson files live under **`/lessons/`** so a lesson slug can't shadow an editor
  root path.
- The iframe `src` is **same-origin**: `/code?url=/lessons/<slug>/<slug>.ne&readOnly=true&deferRuntimeAutostart=true`.
  `VITE_EDITOR_BASE` stays empty in production.

Production config lives in:

- [`Caddyfile`](./Caddyfile) — set `EDITOR_UPSTREAM` (e.g. `https://nexteditor.dev`).
- [`vercel.json`](./vercel.json) — `rewrites` proxy the editor paths (edit the
  destination host) + `headers` apply COOP/COEP origin-wide.

**Local dev** (real same-origin isolation): build + preview the editor in the repo
root (`bun run build && bun run preview` → `:4173`), then `bun run dev` in `tube/`
(`:5174`). Vite's `server.proxy` forwards the editor paths to `:4173` and serves
the isolation headers; `.env` holds `VITE_EDITOR_PROXY_TARGET`.

---

## 10. Implementation steps (for Sonnet 4.6)

1. **Scaffold** the Vite + React + TS app in `tube/` (bun). Add Tailwind v4.
2. Add `src/types.ts` (`Lesson`) and `src/lib/lessons.ts` (typed fetch of
   `/lessons.json`).
3. Add `src/lib/links.ts`:
   - `buildPlayUrl(lesson)` → editor read-only URL using `VITE_EDITOR_BASE` and
     `encodeURIComponent` of the absolute `.ne` URL.
   - `resolveThumb(lesson)` → `/<thumbnail>`.
4. Build `LessonCard`, `LessonGrid`, `Header`, `Footer` (+ optional `SearchBar`).
5. Wire `App.tsx` to render Header + Grid + Footer; handle loading/empty/error.
6. Seed `public/lessons.json` with **one** real entry by copying the existing
   `introduction.ne` + `introduction.en.vtt` from the main repo's `public/` into
   `public/introduction/`, and add a `thumbnail.jpg`.
   - Confirm `introduction.ne` declares `captionFiles: ["introduction.en.vtt"]`; if
     not, re-export or note the limitation.
7. Add `.env.example` (`VITE_EDITOR_BASE=https://nexteditor.dev`) and read it; in dev
   point it at the local editor (`http://localhost:5173`).
8. Add `vercel.json` with the CORS header for `.ne`/`.vtt`.
9. **Manual verification** (user eyeballs UI — do not use a preview browser):
   - `bun run dev`, see the card, click it, confirm it opens the editor in read-only
     playback with audio + captions.
   - `bun run build` succeeds and `bun run typecheck`/lint pass.

---

## 11. Acceptance criteria

- Home page lists all lessons from `lessons.json` as thumbnail-only cards.
- Clicking a card opens `nexteditor.dev/code?url=...&readOnly=true` and the lesson
  plays back read-only (no record UI, import/export hidden).
- Captions appear during playback (given a correctly authored `.ne`).
- Adding a lesson requires only: new `public/<slug>/` folder + one `lessons.json`
  entry — no code changes.
- No backend; deploys as static files to `tube.nexteditor.dev`.

---

## 12. Future enhancements (not v1)

- Category/tag pages and search ranking.
- Optional on-site detail route (`/lesson/<slug>`) with description + "Open in
  editor" button (would need the SPA rewrite + react-router).
- Auto-generate thumbnails from the first frame of a recording.
- A small build script to validate `lessons.json` against the folders in `public/`
  (catch missing files / bad slugs in CI).
- View counts / "recently added" via a lightweight edge function if a backend is
  ever introduced.

```

```
