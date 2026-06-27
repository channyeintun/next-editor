# Plan: First-run product tour with driver.js

Add a guided product tour that highlights the four primary actions of the editor, shown
automatically on a user's first visit to `/code` and replayable on demand.

Tour targets, in order:

1. **Start recording** button — `src/components/MediaControls.tsx`
2. **Settings** button (header) — `src/components/EditorHeader.tsx` (`WorkspaceSettingsButton`)
3. **Preview toggle** button (header) — `src/components/EditorHeader.tsx` (`PreviewHeaderButton`)
4. **Docked runner toggle** button — `src/components/TerminalPanel.tsx` (dock collapse/expand)

## Package manager

This repo uses **bun** (`bun.lock`). Use `bun add`, never npm/yarn/pnpm.

```bash
bun add driver.js
```

`driver.js` is ~5KB, zero-dependency, and framework-agnostic. Import its CSS once.

## Hard constraints discovered in the codebase (do not skip)

### Constraint A — defensive step building (all four targets normally exist)

Every lesson type runs in a WebContainer — `WEB_CONTAINER_LESSON_TYPES` in
`src/types/workspace.ts` includes `html-css` along with react/vue/solid/svelte/htmx-express/express-ts.
So `TerminalPanel` (and its runner-toggle button) is mounted for the default `html-css` workspace too,
and all four `data-tour` targets are present on a normal first visit. Expect **4 steps**.

Still build the step list defensively at runtime: query each `data-tour` selector and drop any step
whose element is `null`, so the tour degrades gracefully if a target is genuinely absent (e.g. a
`readOnly` embed hides the record controls, or markup changes later). Do not hand driver.js a fixed
array that assumes every element is on screen — a missing target makes driver.js center a popover with
no highlight.

### Constraint B — first-visit gate + replay

- Show the tour automatically only the first time, gated by a persisted flag.
- For the persisted "seen" flag, a single `localStorage` key (e.g. `next-editor.tour.v1.seen`)
  read/written directly is acceptable here — this is not reactive shared state, so it does **not**
  need an `@xstate/store-react` store. (Project convention discourages _new_ localStorage+CustomEvent
  _plumbing_ for shared/reactive state; a one-shot boolean flag is fine.)
- Provide a manual replay entry point: add a **"Take a tour"** menu item to the settings dropdown
  in `EditorHeader.tsx` (`WorkspaceSettingsButton`), styled like the existing `role="menuitem"`
  buttons, that calls the tour's `start()` and ignores the seen-flag.

## Implementation steps

### 1. Add stable hooks on the four targets

Add a `data-tour="<id>"` attribute to each target so the tour selects by a stable hook rather than
brittle class chains. Keep existing `aria-*`/`title` attributes intact.

- `MediaControls.tsx` — the record `<button>` (around line 346, the one with title
  `Start Recording`/`Stop Recording`/`New Recording`): add `data-tour="record"`.
- `EditorHeader.tsx` — `WorkspaceSettingsButton`'s `<button>` (the `Settings` icon, ~line 368):
  add `data-tour="settings"`.
- `EditorHeader.tsx` — `PreviewHeaderButton`'s `<button>` (~line 128): add `data-tour="preview"`.
- `TerminalPanel.tsx` — the dock collapse/expand `<button>` (~line 528, aria-label
  "Expand/Collapse runtime dock"): add `data-tour="runner"`.

### 2. Create the tour driver module

New file: `src/components/tour/productTour.ts` (plain module, not a component).

Responsibilities:

- Lazy-create a `driver({...})` instance from `driver.js`.
- Export `buildTourSteps()` that returns only the steps whose `document.querySelector('[data-tour="..."]')`
  resolves to an element, in the fixed order above.
- Export `startTour({ force }: { force?: boolean })`:
  - If `!force` and the seen-flag is already set, return early.
  - Build steps; if zero steps, return.
  - Drive the tour; on completion/close, set the seen-flag.
- Export `hasSeenTour()` / `markTourSeen()` helpers over the `localStorage` key.

Step copy (concise, one sentence each):

- record: "Click here to start (or stop) recording your coding session."
- settings: "Open settings to switch starter templates, manage env vars, and import/export."
- preview: "Toggle the live preview panel to see your project render as you type."
- runner: "Toggle the runner dock here to show or hide the terminal and dev-server output."

driver.js config: `showProgress: true`, `allowClose: true`, `overlayOpacity: ~0.6`,
`stagePadding`/`stageRadius` small for the icon buttons, `popoverClass` for theme matching (optional).

### 3. Auto-start on first visit

In `EditorLayout` (`src/components/Editor.tsx`), add a `useEffect` that:

- Runs once after mount, **after** `urlLoading` is false (don't fire while the loading spinner is up).
- Defers one frame (e.g. `requestAnimationFrame` or a short `setTimeout`) so header/controls have
  painted and the `data-tour` targets exist.
- Calls `startTour({ force: false })`.

Guard against React 19 StrictMode double-invoke (a ref flag) so the tour isn't started twice in dev.

### 4. Manual replay entry in settings menu

In `EditorHeader.tsx` `WorkspaceSettingsButton`, add a `role="menuitem"` button (with a suitable
lucide icon, e.g. `Compass` or `HelpCircle`) labeled **"Take a tour"** that does
`setIsMenuOpen(false)` then `startTour({ force: true })`. Place it near "New Editor" with the existing
divider styling.

### 5. Theming

Import `driver.js/dist/driver.css` once (e.g. at the top of `productTour.ts` or in `App.css`/entry).
Optionally add a small dark-theme override (`.driver-popover` background `#151821`, slate text/borders)
to match the editor chrome, mirroring the palette used in `EditorHeader.tsx`
(`bg-[#151821]`, `border-slate-700`, `text-slate-200`).

## Verification

- `bunx tsc --noEmit` (or the project's typecheck) passes.
- Default `html-css` workspace: tour runs with all **4** steps (record, settings, preview, runner),
  each highlighting a real element, no console error.
- `readOnly` embed (record controls hidden): tour gracefully drops the missing step instead of
  pointing at nothing.
- Reload after completing the tour once: it does **not** auto-start again.
- "Take a tour" always restarts it regardless of the seen-flag.
- Per project convention, do **not** use Claude's preview browser to verify UI — rely on typecheck +
  the user eyeballing it.

## Out of scope

- No backend/persistence beyond the single localStorage flag.
- No analytics on tour completion.
- No mobile-specific tour (the editor route is desktop-oriented).
