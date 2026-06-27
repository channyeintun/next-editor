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

A card's "play" link is:

```
https://nexteditor.dev/code?url=<ENCODED_NE_URL>&readOnly=true
```

Where `<ENCODED_NE_URL>` is the `encodeURIComponent(...)` of the absolute URL of
the lesson's `.ne` file, e.g.:

```
https://nexteditor.dev/code?url=https%3A%2F%2Ftube.nexteditor.dev%2Fintroduction%2Fintroduction.ne&readOnly=true
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

## 3. Cross-origin requirements (do not skip)

Because `.ne` (and `.vtt`) files are served from `tube.nexteditor.dev` but fetched
by a page on `nexteditor.dev`, the requests are **cross-origin**:

1. **CORS** — `tube.nexteditor.dev` must send `Access-Control-Allow-Origin` for the
   `.ne` and `.vtt` files. Simplest: `Access-Control-Allow-Origin: *` on all static
   assets. (The editor first tries `nexteditor.dev/api/proxy?url=...`; on Vercel
   that path 404s and the loader falls back to a direct cross-origin `fetch`, which
   then needs CORS.)
2. **Captions are fetched directly (not via proxy)** — `.vtt` files also need CORS.
3. **COEP note** — the editor page runs under `Cross-Origin-Embedder-Policy:
require-corp` (for WebContainer). This gates _subresource tags_ (img/script), not
   `fetch()` responses, so CORS alone is sufficient for `.ne`/`.vtt`. The tube site
   itself does **not** need COEP/COOP headers.

> Alternative if CORS proves annoying: host the `.ne`/`.vtt` files under
> `nexteditor.dev` (same origin as the editor) and keep only the _gallery UI_ on
> `tube.nexteditor.dev`. v1 assumes the CORS approach since the user wants lessons
> to live with the tube site.

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

## 9. Deployment

- Separate Vercel project (or Caddy site) bound to `tube.nexteditor.dev`.
- Static build (`bun run build` → `dist/`).
- **Headers:** add `Access-Control-Allow-Origin: *` for `.ne` and `.vtt` (and it's
  fine to apply broadly to static assets). On Vercel, via `vercel.json` `headers`.
  Do **not** copy the main app's COEP/COOP headers here — they're unnecessary and
  COEP could complicate thumbnail loading.
- SPA fallback rewrite to `/index.html` only if a client-side detail route is added;
  not required for the single-page v1.

Example `vercel.json`:

```jsonc
{
  "installCommand": "bun install",
  "buildCommand": "bun run build",
  "headers": [
    {
      "source": "/(.*)\\.(ne|vtt)",
      "headers": [{ "key": "Access-Control-Allow-Origin", "value": "*" }],
    },
  ],
}
```

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
