# Plan: "Continue to Next" + "Autoplay" switches in Media Controls settings

## Goal

Add two persistent, switch-controlled settings to the MediaControls settings popover
(the gear menu that today holds Speed, Volume, Import captions):

1. **Autoplay** — when a lesson recording finishes loading, playback starts
   automatically instead of waiting for the user to press play.
2. **Continue to Next** — when the user is playing lessons _from a playlist_ and a
   lesson finishes, automatically advance to the next lesson in that playlist.

No implementation in this pass — this document is the plan.

## Current state (what the code does today)

- **Lesson playback**: `/learn/:slug` → [LessonDetailRoute.tsx](tube/src/components/LessonDetailRoute.tsx)
  → [LessonDetail.tsx](tube/src/components/LessonDetail.tsx) renders
  `<Editor readOnly recordingUrl={/${lesson.ne}} …/>` from [Editor.tsx](src/components/Editor.tsx).
- **Playlist page**: `/learn/playlist/:slug` → [PlaylistDetail.tsx](tube/src/components/PlaylistDetail.tsx)
  renders plain [LessonCard.tsx](tube/src/components/LessonCard.tsx)s linking to `/learn/${lesson.slug}`.
  **No playlist context survives the click** — once you're on a lesson page, the app has
  no idea you came from a playlist. This is the main gap for "Continue to Next".
- **Settings popover**: [MediaControls.tsx:582-631](src/components/MediaControls.tsx:582) —
  Speed slider, Volume slider, "Import captions…". No switch rows exist yet; there is no
  reusable Switch component in the repo.
- **End-of-playback signal**: `selectHasEnded` ([useNextEditor.ts:90](src/core/src/useNextEditor.ts:90))
  is exposed as `hasEnded` via `useNextEditorMetadata()` — true when the machine is in
  `playback: "ended"` at (duration − ε). This is the trigger for auto-advance.
- **Settings persistence convention**: `@xstate/store-react` `createStore` with a
  `localStorage`-backed context, e.g. [captionStore.ts](src/stores/captionStore.ts). Follow that pattern.
- **Autoplay policy reality**: playback needs the shared `AudioContext`; MediaControls
  unlocks it inside click handlers. A cold page load has no user gesture, so an autoplay
  attempt can be blocked by the browser. [FloatingPlayButton.tsx](src/components/FloatingPlayButton.tsx)
  (shown while `currentTime === 0` and not playing) is the natural fallback when that happens.

## Design decisions

1. **Playlist context travels as a query param**: playlist lesson links become
   `/learn/:slug?list=<playlist-slug>` (YouTube's `watch?v=…&list=…` shape). Deep-linkable,
   refresh-safe, and requires no new global state. `LessonDetail` resolves the playlist with
   the existing `usePlaylist(slug)` hook (cached, `staleTime: 60s`).
2. **One new global settings store, module-level singleton** —
   `src/stores/playbackSettingsStore.ts` holding `{ autoplay: boolean, continueToNext: boolean }`,
   persisted to `localStorage` (keys e.g. `playback-autoplay`, `playback-continue-to-next`).
   Singleton (not a Provider) because two _sibling_ trees need it: MediaControls (inside the
   Editor provider stack) and tube's `LessonDetail` (outside it). Defaults: both **off**.
3. **The editor stays playlist-agnostic.** `Editor` gains a generic `onEnded?: () => void`
   prop (same spirit as `renderPostRecordingModal` / `breadcrumb`); the playlist-advance
   logic lives entirely in tube. `Editor` also gains `playlistMode?: boolean` so
   MediaControls knows whether to show the "Continue to Next" row at all.
4. **Semantics of the two switches** (recommended):
   - _Autoplay_ governs "start playing when a lesson loads" — applies to read-only lesson
     playback only (`readOnly === true`), never to the `/code` authoring route.
   - _Continue to Next_ governs "advance at the end". When it fires, the next lesson
     **always starts playing** (that is what "continue" means), regardless of the Autoplay
     switch — implemented by passing a one-shot autoplay override through router
     navigation state, consumed on mount.
   - Last lesson of the playlist: do nothing (no wrap-around/loop in v1).
5. **Switch visibility**: "Autoplay" shows whenever the settings popover is available in
   read-only playback. "Continue to Next" shows only when `playlistMode` is true (a switch
   that can never do anything is noise).

## Implementation steps

### 1. `src/stores/playbackSettingsStore.ts` (new)

- `createStore` from `@xstate/store-react`, mirroring [captionStore.ts](src/stores/captionStore.ts):
  `readInitialContext()` from `localStorage`, events `setAutoplay`, `setContinueToNext`
  (or `toggleX`), `store.subscribe` writes back to `localStorage`.
- Export a module-level singleton `playbackSettingsStore`, selectors
  `selectAutoplay` / `selectContinueToNext`, and use `useSelector` from
  `@xstate/store-react` at call sites. Guard `typeof window === "undefined"` like captionStore.
- Unit test alongside (`playbackSettingsStore.test.ts`): defaults, toggle events,
  localStorage round-trip — same shape as `apiClientStore.test.ts`.

### 2. Reusable `Switch` component — `src/components/Switch.tsx` (new)

- `<button role="switch" aria-checked>` with a sliding thumb; dark-theme styling matching
  the popover (track `bg-slate-600`, checked accent `#10c776` to match the existing slider
  accents), label on the left, switch on the right.
- Props: `checked`, `onChange`, `label` (string), optional `disabled`.

### 3. MediaControls settings popover — [MediaControls.tsx](src/components/MediaControls.tsx)

- New props: `playlistMode?: boolean` (default false), and implicitly the existing
  `recordMode` already distinguishes read-only playback.
- In the popover, after the Volume block and before the captions divider, add a
  settings section with:
  - `Switch` "Autoplay" — bound to `playbackSettingsStore` (`selectAutoplay`). Rendered
    when `!recordMode` (read-only playback).
  - `Switch` "Continue to Next" — bound to `selectContinueToNext`. Rendered only when
    `playlistMode` is true.

### 4. Editor plumbing — [Editor.tsx](src/components/Editor.tsx)

- New `EditorProps`: `onEnded?: () => void`, `playlistMode?: boolean`, and
  `autoplayOverride?: boolean` (one-shot force-play used by auto-advance; ORed with the
  stored Autoplay setting).
- `EditorLayout`:
  - Pass `playlistMode` through to `<MediaControls …/>`.
  - **Ended watcher**: `useEffect` on `hasEnded` (from `useNextEditorMetadata()`); on the
    false→true transition call `onEnded?.()`. Fire once per ended-transition (track the
    previous value in a ref) so seeks/replays re-arm it.
  - **Autoplay effect** (only when `readOnly`): once `urlLoading` is false with no error and
    `currentRecording` is set, if (`autoplay` setting || `autoplayOverride`) and not already
    playing and `currentTime === 0`, unlock the audio context and call `play()` exactly once
    per loaded recording URL (ref-guard keyed by `recordingUrl`). If the browser blocks it,
    state stays at `currentTime === 0` and `FloatingPlayButton` remains the visible fallback —
    no error UI needed.

### 5. Playlist context in tube

- **[PlaylistDetail.tsx](tube/src/components/PlaylistDetail.tsx) / [LessonCard.tsx](tube/src/components/LessonCard.tsx)**:
  give `LessonCard` an optional `listSlug?: string` prop; when set, both links become
  `/learn/${lesson.slug}?list=${listSlug}`. PlaylistDetail passes its own slug. Grid/search
  usages are untouched.
- **[LessonDetail.tsx](tube/src/components/LessonDetail.tsx)** (grows the playlist logic;
  LessonDetailRoute stays as-is):
  - Read `list` via `useSearchParams`; call `usePlaylist(listSlug)` (already handles
    undefined via `enabled`).
  - Compute `currentIndex` by matching `lesson.slug` in `playlist.lessons`, and `nextLesson`
    (`undefined` at the end or when the lesson isn't actually in the playlist — treat a
    stale/foreign `?list=` as no playlist context).
  - `playlistMode = Boolean(playlist && currentIndex !== -1)` → pass to `<Editor/>`.
  - `onEnded`: if `continueToNext` (read from the store snapshot at call time) and
    `nextLesson` exists → `navigate(`/learn/${nextLesson.slug}?list=${listSlug}`, { state: { autoplay: true } })`.
  - Read `location.state?.autoplay` → pass as `autoplayOverride` to `<Editor/>` (router
    state is not part of the URL, so refresh/deep-link doesn't force-play).

### 6. Verification

- `bun run typecheck`, `bun run lint`, `bun run test` (vp). New unit tests: the store
  (step 1) and, if extracted, a pure `findNextLesson(playlist, slug)` helper.
- Manual eyeball (user): playlist → lesson shows both switches; toggles persist across
  reload; lesson end auto-advances and plays next; last lesson stops; direct `/learn/:slug`
  (no `?list=`) hides "Continue to Next"; Autoplay off + cold load still shows the floating
  play button.

## Task decomposition (for implementation, per AGENTS.md)

Independent, parallelizable units: (A) store + test, (B) Switch component, (C) LessonCard
`listSlug` threading. Sequential after those: (D) MediaControls popover rows (needs A+B),
(E) Editor `onEnded`/autoplay plumbing (needs A), (F) LessonDetail playlist logic (needs C+E),
then integration + verification. Commits serialized per repo convention.

Suggested commit message (implementation):
`feat: add autoplay and continue-to-next playback settings with playlist auto-advance`

## Out of scope (v1)

- Loop/shuffle, "up next" sidebar or countdown toast before advancing, keyboard shortcut,
  playlist progress indicator in the breadcrumb. All are natural follow-ups; the
  `?list=` param + store put the state in place for them.
