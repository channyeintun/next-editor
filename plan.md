# Plan: driver.js-style landing page sections

Add four new sections to the landing page, modeled on the information structure of
https://driverjs.com/. Everything lands in **`src/components/LandingPage.tsx`** (single-file
component today) between the existing feature-cards grid and the `<footer>`.

New sections, in order:

1. **"Works with any stack" animation section** — the analogue of driver.js's _"Works with any
   framework or library, or even with vanilla JavaScript"_ animated row.
2. **Use Cases** — a grid of concrete scenarios Next Editor is good for.
3. **MIT Licensed / Free for everyone, forever** — license + pricing reassurance band.
4. **"Star on GitHub"** CTA with a live star count, plus a GitHub-star button.

## Constraints discovered in the codebase (do not skip)

### No new dependencies needed

- Icons: use **`lucide-react`** (already imported in `LandingPage.tsx`: `Maximize`, `Play`, etc.).
  The GitHub mark already exists as inline SVG in `src/components/Navbar.tsx:27` — copy that path,
  do **not** add an icon package.
- Animation: there is **no `framer-motion`** in this project. Scroll-reveal is done with a plain
  `IntersectionObserver` — see the `featuresRef` / `featuresInView` pattern in
  `LandingPage.tsx:26-40`. Reuse that pattern (or a small generic hook) for any new reveal.
  CSS keyframe animations (`animate-[fade-up_…]`, `animate-[draw_…]`) are defined in `src/index.css`
  and already used inline — prefer these over JS animation.

### Design tokens (already defined in `src/index.css`, lines 36-43) — use them, don't hardcode

- Fonts: `font-machina` (headings, uppercase display), `font-telegraf` (body).
- Colors: `pinata-purple #6d57ff`, `pinata-cyan #4de5d6`, `pinata-green #3ace8c`,
  `pinata-orange #ff8f33`, `pinata-yellow #ffd255`. Page bg is `#11141c`; cards use
  `bg-[#181d24]/90 border border-slate-800 rounded-4xl`. Match this exactly so the new sections
  read as part of the existing page.

### GitHub repo

- The repo is **`channyeintun/next-editor`** (`src/components/Navbar.tsx:21`). Use this for both the
  star link and the star-count API call.
- License is **MIT**, `Copyright (c) 2026 Chan Nyein Tun` (`LICENSE`). The footer already says
  `© 2026 Next Editor`.

### Templates / stacks to feature

The "works with any stack" section should mirror the real starter templates (from the README and the
editor header): **HTML/CSS, React, Vue, Solid, Svelte, HTMX + Express, Node/Express (TS)**.
`WEB_CONTAINER_LESSON_TYPES` lives in `src/types/workspace.ts` if an authoritative list is wanted.

---

## Section 1 — "Works with any stack" animated row

driver.js shows a sentence with the framework name cycling. Our version:

> **"Record lessons for any stack — React, Vue, Solid, Svelte, HTMX, or plain HTML/CSS."**

Implementation options (pick the simpler one):

- **Cycling word** (closest to driver.js): a single highlighted slot that swaps the framework name
  on an interval with a short fade/slide. Drive it with `useState` + `setInterval` cycling an array
  of names; apply the existing `animate-[fade-up_…]` keyframe on each change via a `key` bump.
  Respect `prefers-reduced-motion` (the page already uses `motion-reduce:` utilities — mirror that).
- **Logo strip** (simpler, robust): a centered row of framework name pills / inline SVG logos that
  fade up in sequence when scrolled into view (`IntersectionObserver`, staggered with
  `[animation-delay]`). No external logo assets — render the names as styled pills using the pinata
  colors, or small inline SVGs if desired.

Recommended: cycling word for the headline + a static pill row beneath it.

Heading style: `font-machina`, uppercase, large; body `font-telegraf text-slate-400`.

## Section 2 — Use Cases

A responsive grid (`grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8`) of cards reusing the existing
card shell (`bg-[#181d24]/90 border border-slate-800 p-8 rounded-4xl`). Each card: a colored
lucide icon tile (same `rounded-2xl size-12` treatment as the numbered feature cards at
`LandingPage.tsx:351-356`, but with an icon instead of a number), a `font-machina` title, and a
`text-slate-400` description.

Suggested use cases (6 cards):

1. **Interactive tutorials** — turn a real coding session into a step-through lesson.
2. **Course & workshop content** — build replayable lessons learners explore in the browser.
3. **Documentation & guides** — embed a live `/code?url=…` recording instead of static GIFs.
4. **Onboarding** — walk new teammates through a codebase change as it happened.
5. **Conference talks & demos** — present with synced slides (reveal.js) and narration.
6. **Async code reviews / bug repros** — record the exact edits and runtime state, share a link.

Pull copy from the README "Overview"/"Current Capabilities" so claims stay accurate (slides, audio,
captions, `.ne` sharing, WebContainer runtime). Cycle through the five pinata colors for icon tiles.

## Section 3 — MIT Licensed / Free for everyone, forever

A centered band (no card, or one wide highlighted card) echoing driver.js's reassurance section:

- Big `font-machina` headline: **"Free for everyone, forever"**.
- Sub-line: **"MIT Licensed."** with a short sentence: open source, no account required, self-hostable
  (`SELF_HOSTING.md` exists — can link it or the GitHub repo).
- Optional small badges: `MIT`, `Open Source`, `No sign-up` rendered as pinata-colored pills.
- Keep it visually distinct: e.g. a subtle radial-gradient blob like the hero
  (`LandingPage.tsx:98-102`) or a `pinata-purple`/`pinata-cyan` accent border.

## Section 4 — "Star on GitHub" CTA + live star count

- A prominent **"Star on GitHub"** button linking to `https://github.com/channyeintun/next-editor`
  (`target="_blank" rel="noopener noreferrer"`). Style like the hero CTA
  (`LandingPage.tsx:154-159`: `rounded-full bg-slate-950 text-white … hover:scale-105`) but include
  the inline GitHub mark + a star (`Star` from lucide-react) and the count.
- **Live star count**: fetch on mount.
  - Endpoint: `https://api.github.com/repos/channyeintun/next-editor` → `stargazers_count`.
  - Use `useEffect` + `fetch`, store in state, and **render nothing (or just the button without a
    number) until loaded**. The GitHub unauthenticated API is rate-limited (60 req/hr/IP) and may
    fail — wrap in try/catch and fall back gracefully (hide the number; never block the button).
  - Format large numbers (e.g. `1.2k`) with a tiny helper.
  - For a one-off page fetch, local `useState` in `LandingPage` is fine (no new global store).

Place this CTA last, just above the `<footer>`. Optionally also surface the star count on the existing
Navbar GitHub button (`src/components/Navbar.tsx:20-34`) — note it but keep scope tight.

---

## Verification (per project memory — do NOT use the preview browser)

- `bunx tsc --noEmit` (or the project's typecheck script) must pass — this is the primary gate.
- Run the test suite with **`npx vp test run`** (per memory; not bare vitest) if any logic is added.
- Use **bun** for any dependency work (`bun add …`) — but this plan needs **no new deps**.
- Let the user eyeball the UI in their own browser; do not launch Claude's preview/verify flow for
  this project.

## Out of scope / notes

- Don't restructure the hero or the existing 3 feature cards — only append new sections.
- Keep mobile in mind: the page already guards a heavy iframe behind `isMobileBrowser()`; the new
  sections are static/light and need no such guard, but verify the grids collapse to one column.
- If the cycling-word animation feels risky, ship the static pill row first; it's the safe default.
