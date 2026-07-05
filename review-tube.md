# Code review — `tube/`

Scope: the `/learn` gallery SPA — catalog fetching (`src/lib/`), hooks, the
route/page components, and the two Vite plugins (`vite/`). Reviewed for
correctness and security; nothing implemented.

Overall this is clean, presentational React. User-supplied strings (titles,
author names, descriptions) are rendered as text, so React's escaping covers
the obvious XSS surface, and every author/lesson link is built from
server-controlled values. The catalog-fetch layer is the most logic-heavy part
and is where the notable finding is. No High-severity issues.

---

## Medium

### T1 — D1 fetch paths lack the SPA-HTML-fallback guard the seed paths have (asymmetry → crash on HTML) — **FIXED**

> Both `fetchD1Page` and the D1 branch of `findLessonBySlug` (`src/lib/lessons.ts`)
> now call `isHtmlFallback` the same way the seed paths already did — an HTML
> response is treated as "no results" / "not found" instead of trusted as JSON.
> Added matching regression tests in `lessons.test.ts` mirroring the existing
> seed-path coverage.

**File:** `src/lib/lessons.ts:58-61` (`fetchD1Page`), `:100-106` (`findLessonBySlug` D1 branch)

The seed paths are hardened against the Worker's
`not_found_handling = "single-page-application"` behaviour: `fetchSeedPage`
(`:47-56`) and the seed branch of `findLessonBySlug` (`:91-98`) call
`isHtmlFallback(res)` and treat a `200 text/html` response as "not found"
instead of trusting garbage HTML as JSON. This is exactly the bug the tests at
`lessons.test.ts:70` and `:115` were written for.

The **D1 branches do not do this**:

- `fetchD1Page` returns `res.data` unconditionally. If `/api/lessons?page=N`
  ever answers with the SPA shell, `res.data` is an HTML string, `page.lessons`
  is `undefined`, and the caller's `data?.pages.flatMap((p) => p.lessons)`
  (`LessonGrid.tsx:64`) flattens `undefined` into the list → `LessonCard`
  receives `undefined` → crash.
- `findLessonBySlug`'s D1 branch (`:100-106`) likewise trusts any `200` as a
  real `Lesson`.

In production this is unreachable — the Worker matches `/api/lessons*`
explicitly and always returns JSON. But it **is** reachable in plain
`bun run dev` without the Worker (only `/lessons/*` and `/api/slide-image` have
dev middleware; `/api/lessons` falls through to Vite's SPA index), which is the
first thing that happens once the seed reports `nextPage: null` and the client
advances to `d1:0`. Given the seed path already documents and defends this
exact hazard, the D1 path should apply the same `isHtmlFallback` guard for
symmetry and dev robustness.

---

## Low

### T2 — `/learn/@` (empty handle) spins forever — **FIXED**

> `LearnSlugRoute` now redirects to `/learn` (via `<Navigate replace>`) when the
> `@`-prefixed slug has no username after it, instead of rendering
> `AuthorProfilePage` with an empty string.

**Files:** `src/components/LearnSlugRoute.tsx:15-18`, `src/AuthorProfilePage.tsx:41-49`,
`infra/client/authors/useAuthorProfile.ts`

`LearnSlugRoute` routes any slug starting with `@` to `AuthorProfilePage` with
`username = slug.slice(1)`. For the URL `/learn/@`, that yields `username = ""`.
`useAuthorProfile("")` has `enabled: !!username` → `false`, so the query never
runs and `isPending` stays `true` forever, leaving the user on a permanent
"Loading profile…" state rather than an "Author not found" / redirect. Guard
the empty-username case (treat it as not-found, or redirect to `/learn`).

### T3 — Avatar/name initial assumes a non-empty `name` — **FIXED**

> Swapped `??` for `||` at all three call sites (`AuthorProfilePage.tsx`,
> `SearchResults.tsx`, and `infra/client/auth/AuthMenu.tsx`), so an empty-string
> `name` falls back to the username/email the same way `null`/`undefined` does.

**Files:** `src/AuthorProfilePage.tsx:86` & `:103-104`, `src/components/SearchResults.tsx:64-68`,
`infra/client/auth/AuthMenu.tsx:48`

`const displayName = data.user.name ?? data.user.username` (and the sibling
`(author.name ?? author.username)[0]`, `(user.name ?? user.email)[0]`) use `??`,
which only falls back on `null`/`undefined`, not on an empty string. A user whose
`name` is `""` yields `displayName = ""` and `displayName[0] === undefined`, so
the avatar-fallback initial and the `<h1>` render blank. Google names are
effectively always present, so this is cosmetic — prefer `name || username` if
you want to be defensive.

---

## Notes (no action needed)

- User-controlled text (titles, descriptions, author names, usernames) is
  rendered as JSX text content — React escapes it, so no reflected/stored XSS
  here. `authorUrl` used in `<Link to>` is server-generated as
  `/learn/@<username>`, not free-form.
- `LearnSlugRoute`'s `@`-prefix disambiguation is safe because `slugify`
  (`infra/worker/routes/lessons.ts`) strips leading non-alphanumerics, so a
  lesson slug can never start with `@`. The `react-router` param-compilation
  caveat is well explained.
- `findLessonBySlug` / `fetchAuthorProfile` correctly `encodeURIComponent` the
  slug/username before building request URLs.
- `lessonsApiPlugin` (`vite/lessonsApiPlugin.ts`) skips emitting `by-slug`
  shards whose slug contains `/` at build time (`:91`) but the dev middleware
  would still serve them via `bySlug.get(...)` — harmless because slugs never
  contain `/`, noting only as a latent dev/build asymmetry.
- `formatPublished` (`LessonCard.tsx:10-15`) parses `YYYY-MM-DD` as a local
  date and matches the shape both the seed manifest and
  `lessonRowToLesson` produce — consistent.
