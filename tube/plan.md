# NextEditor Tube — Implementation Plan

A "YouTube for code lessons": a lesson **gallery** showing YouTube-style cards
(thumbnail image only — no video on the card). Clicking a card opens a detail view
that renders the real **`Editor`** component directly (read-only playback); because
it's the same app, viewers can also run/edit the code live (WebContainer).

**Architecture (B2 — `/learn` route, monorepo package).** `tube` is a workspace-style
**package** (`@next-editor/tube`) living in the `tube/` folder. The main app mounts
its `LearnPage` at the **`/learn`** route, so the gallery, the editor (`/code`), and
the lesson files are all served from **one origin** by the existing app — no
subdomain, no reverse proxy, no CORS. Cross-origin isolation (already set by the
main app for WebContainer) covers `/learn` automatically.

> tube is resolved to its source via a tsconfig `paths` entry + a Vite
> `resolve.alias` (not a bun workspace — bun's workspace mode drops a scoped
> platform dep of `vite-plus` in this repo). It's still a self-contained package
> with its own `package.json`; only the resolution mechanism differs.

---

## 1. Goals & non-goals

**Goals**

- Fast gallery of recorded lessons, shipped as part of the existing app at `/learn`.
- Lessons authored manually: drop a folder into the main app's `public/lessons/`,
  add an entry to `public/lessons.json`. No CMS, no database.
- Cards open the _real_ editor component directly (read-only playback by default);
  the gallery itself never parses or plays `.ne`.
- Recording stays exclusively on `/code` (no record UI in the gallery).

**Non-goals (v1)**

- No accounts, comments, likes, view counts, or uploads.
- No `.ne` parsing in the gallery — it only links to lesson files and embeds `/code`.
- No new backend or separate deploy — it builds and ships with the main app.

---

## 2. The link contract (most important part)

No iframe, and **no editor query params**. The gallery and the editor are the **same
app**, so the detail view renders the `Editor` component directly (lazy-loaded) and
drives it through **props**, not the URL.

- Routes: `/learn` (grid) and **`/learn/:slug`** (detail). Cards are `<Link
to="/learn/<slug>">` — clean, shareable, middle-click-to-new-tab.
- `LessonDetailRoute` resolves `:slug` → the lesson (from `lessons.json`) and renders
  `<Editor readOnly recordingUrl={"/" + lesson.ne} />`.

`Editor` accepts optional props (added to the main app) and **falls back to URL
params** when they're omitted, so the existing `/code` route is unchanged:

| Prop            | Fallback (when prop omitted) | Effect                                         |
| --------------- | ---------------------------- | ---------------------------------------------- |
| `readOnly`      | `?readOnly=true`             | playback mode (no import/export, record, tour) |
| `recordingUrl`  | `?url=`                      | the `.ne` to load (via `useUrlQuery`)          |
| `largeControls` | `?largeControls=true`        | enlarged playback controls                     |

> The detail URL is just `/learn/introduction` — no `?url=…&readOnly=…` clutter.
> (`deferRuntimeAutostart` was a dead param and has been dropped.)

---

## 3. Origin model (B2 — one app, one origin)

The gallery is a route (`/learn`) inside the editor app, and the `Editor` renders in
the same page (no iframe), so the gallery, the editor, and the lesson files are **all
same-origin**. That means:

- **No CORS, no reverse proxy, no iframe** — the editor fetches `.ne`/`.vtt` from the
  same origin directly.
- **Cross-origin isolation already works** — the main app serves
  `COOP: same-origin` + `COEP: require-corp` on every response (for WebContainer),
  so `/learn` (and the `Editor` it renders) is cross-origin isolated; WebContainer
  (`SharedArrayBuffer`) can boot for live run/edit.
- The only genuinely cross-origin resources are the editor's own WebContainer CDN
  calls (`*.staticblitz.com`), which already serve COEP-compatible headers.

> Why not a separate `tube.nexteditor.dev` subdomain? A cross-origin iframe can't be
> made cross-origin-isolated without `CORP` on every subresource (brittle), and a
> reverse proxy adds an edge layer. Mounting at `/learn` on the existing origin and
> rendering the `Editor` directly is the simplest correct option.

---

## 4. Lesson authoring workflow (manual)

Lesson files live in the **main app's** `public/` (it's the server that hosts both
the gallery and the editor).

1. Create a folder under `public/lessons/<slug>/` (repo root `public/`) containing:
   - `<slug>.ne` — the recording (exported from `/code`).
   - `<slug>.<lang>.vtt` — one or more caption tracks (e.g. `introduction.en.vtt`).
   - `thumbnail.jpg` (or `.png`/`.webp`/`.svg`) — the card image (16:9 recommended).
2. **Make sure the `.ne` declares its captions.** Captions auto-load only if the
   recording's `captionFiles` field lists the sibling VTTs (resolved relative to the
   `.ne` URL). If a recording was exported without it, the `.vtt` won't show during
   playback.
   - Recommended convention: `captionFiles: ["<slug>.en.vtt"]` inside the recording.
3. Add an entry to `public/lessons.json` (see schema below).

Example tree (in the repo-root `public/`; lessons namespaced under `lessons/` so a
slug can't shadow an editor root path like `/assets` or `/fonts`):

```
public/                      <- main app public/ (served at the origin root)
  lessons.json
  lessons/
    introduction/
      introduction.ne
      introduction.en.vtt
      thumbnail.svg
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
      "thumbnail": "lessons/introduction/thumbnail.svg", // path under public/
      "ne": "lessons/introduction/introduction.ne", // path under public/
      "duration": "4:12", // optional, display-only string
      "tags": ["intro", "basics"], // optional, for filtering later
      "author": "Chan", // optional
      "publishedAt": "2026-06-28", // optional, ISO date for sorting
    },
  ],
}
```

Runtime paths:

- thumbnail `src` = `/<thumbnail>` (same-origin; `resolveThumb` in
  `tube/src/lib/links.ts`).
- the recording is passed to the editor as a prop:
  `<Editor recordingUrl={"/" + lesson.ne} />` — a same-origin path fetched from this
  origin. No `?url=` query param.

---

## 6. Tech stack

The `@next-editor/tube` package is a thin React UI compiled by the **main app's**
build (Vite + React 19 + TS + Tailwind v4), so it has **no build tooling of its
own**:

- React 19 + TypeScript + Tailwind v4 utility classes (compiled by the main app;
  `src/index.css` adds `@source "../tube/src"` so Tailwind scans the package).
- **lucide-react** for icons + **react-router** `Link`/hooks (peer deps, already in
  the main app).
- Resolution: tsconfig `paths` + Vite `resolve.alias` map `@next-editor/tube` →
  `tube/src/index.tsx`, and `@app/*` → the main app's `src/*` (for the `Editor`).

No `.ne` decoding deps, no WebContainer, no xstate in the package itself — those run
inside the lazy-loaded `Editor` it renders.

---

## 7. Project structure

```
tube/                        <- @next-editor/tube package (UI only, no build tooling)
  plan.md                    <- this file
  progress.md
  package.json               <- name + peerDeps + exports ./src/index.tsx
  src/
    index.tsx                <- package entry: default=LearnPage, LessonDetailRoute
    LearnPage.tsx            <- grid page (/learn)
    lib/
      lessons.ts             <- fetch + type for /lessons.json
      links.ts               <- resolveThumb(lesson)
    components/
      Header.tsx             <- logo + "Record your own" CTA to /code
      LessonGrid.tsx         <- responsive grid + search
      LessonCard.tsx         <- thumbnail-only card; <Link to="/learn/:slug">
      LessonDetailRoute.tsx  <- /learn/:slug → resolve slug → lesson
      LessonDetail.tsx       <- lazy-renders @app Editor (readOnly prop) + back link
      SearchBar.tsx          <- client-side filter (title/tags)
      Footer.tsx
    types.ts                 <- Lesson type

(main app, repo root)
  src/router.tsx             <- /learn + /learn/:slug routes → @next-editor/tube
  src/components/Editor.tsx  <- EditorProps (readOnly/recordingUrl/largeControls)
  src/hooks/useUrlQuery.ts   <- accepts an override url (recordingUrl prop)
  src/index.css              <- @source "../tube/src" (Tailwind scan)
  tsconfig.json              <- paths: @next-editor/tube → tube/src; @app/* → src/*
  vite.config.ts             <- resolve.alias for @next-editor/tube and @app
  public/
    lessons.json
    lessons/<slug>/...       <- lesson folders (see §4)
```

---

## 8. Components

**`LessonCard`** (YouTube-style, thumbnail only)

- 16:9 thumbnail `<img loading="lazy">` with rounded corners; optional duration
  badge in the corner (from `lesson.duration`).
- Below: title (2-line clamp), author + publishedAt meta row.
- Entire card is a `<Link to="/learn/<slug>">` — shareable URL, middle-clickable.
- Hover: subtle scale/elevation, matching the main landing page's aesthetic.

**`LessonDetailRoute`** (`/learn/:slug`)

- Resolves `:slug` → lesson from `lessons.json`; loading / not-found / error states.

**`LessonDetail`** (full-screen detail view)

- Lazy-loads the host app's `Editor` (`lazy(() => import("@app/components/Editor"))`)
  so the gallery chunk stays tiny; the editor bundle downloads only on open.
- Renders `<Editor readOnly recordingUrl={"/" + lesson.ne} />` (props, not URL params)
  under a floating "back" `<Link>`.

**`LessonGrid`**

- `fetch('/lessons.json')` once, render cards. Responsive: 1 col mobile → 4 cols
  desktop. Loading + empty + error states.

**`Header`**

- Left: NextEditor Tube wordmark/logo.
- Right: a "Record your own" button linking to `/code` (recording lives only there).

**`SearchBar`** (optional, nice-to-have)

- Client-side filter over title/tags. No backend.

---

## 9. Deployment — none of its own (ships with the main app)

There is **no separate deploy**. The gallery is the `/learn` route of the existing
editor app, so building and deploying the main app ships it. Concretely:

- The main app already serves `COOP: same-origin` + `COEP: require-corp` on every
  response (for WebContainer). `/learn` is therefore cross-origin isolated, and the
  same-origin `/code` iframe inherits it — live run/edit works with **zero extra
  config**.
- Lesson files are static assets in the main app's `public/` → served at the origin
  root (`/lessons/...`, `/lessons.json`).
- No CORS, no reverse proxy, no `tube.*` subdomain, no `Caddyfile`/`vercel.json` in
  the package.

> Read-only **playback** alone wouldn't even need isolation — the preview/terminal
> replay via rrweb, and the editor gates WebContainer auto-boot off when
> `crossOriginIsolated` is false. Same-origin `/learn` gives isolation for free, so
> the run-it-yourself capability also works.

**Local dev:** just run the main app (`bun run dev`) and open `/learn`. One server,
one origin — clicking a card embeds `/code` in the overlay and plays back.

---

## 10. Implementation steps (history)

> Implemented across several iterations: (1) standalone Vite gallery → (2) embedded
> iframe instead of navigation → (3) B1 reverse-proxy subdomain → **(4, current) B2
> `/learn` route as a workspace-style package**. The current shape is what §2–§9
> describe; the list below is the high-level path taken.

1. Scaffold the gallery UI (cards, grid, search, player) with React + Tailwind.
2. `types.ts` + `lib/lessons.ts` (typed `/lessons.json` fetch) + `lib/links.ts`
   (`buildPlayUrl` same-origin `/code` URL, `resolveThumb`).
3. `LessonPlayer` overlay embedding the `/code` iframe (Esc/close, scroll lock).
4. Convert `tube` to the `@next-editor/tube` package (entry `src/index.tsx` →
   `LearnPage`); remove all standalone app/build/deploy files.
5. Mount at `/learn` in `src/router.tsx`; wire resolution via tsconfig `paths` +
   Vite `resolve.alias`; add `@source "../tube/src"` for Tailwind.
6. Move lesson assets into the main app's `public/lessons/` + `public/lessons.json`.
7. Fix the main-app loader so a SPA-fallback proxy response can't masquerade as a
   recording (`src/hooks/useUrlLoader.ts`) — relevant to any URL-loaded `.ne`.
8. Verify: `tsc -b`, `vp lint`, `vp build` all pass; Tailwind scans the package.

---

## 11. Acceptance criteria

- `/learn` lists all lessons from `lessons.json` as thumbnail-only cards.
- Clicking a card navigates to `/learn/<slug>` (clean URL, no query params) which
  renders the real `Editor` directly (lazy-loaded), driven by **props**
  (`readOnly`, `recordingUrl`) — read-only playback, no record UI/import/export.
  The Editor is a separate chunk — the gallery stays tiny.
- Captions appear during playback (given a correctly authored `.ne`).
- The embed is cross-origin isolated, so viewers can run/edit the code live.
- Adding a lesson requires only: new `public/lessons/<slug>/` folder + one
  `lessons.json` entry — no code changes.
- No separate deploy or backend — it builds and ships with the main app.

---

## 12. Future enhancements (not v1)

- Category/tag pages and search ranking.
- Optional on-site detail route (`/learn/<slug>`) with description + "Open in
  editor" button (the main app's react-router is already available).
- Auto-generate thumbnails from the first frame of a recording.
- A small build script to validate `lessons.json` against the folders in `public/`
  (catch missing files / bad slugs in CI).
- View counts / "recently added" via a lightweight edge function if a backend is
  ever introduced.

```

```
