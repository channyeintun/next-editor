# Review: Playlist, Autoplay, Continue-to-Next

Date: 2026-07-10. **Update (same day): findings 1–6 are fixed** — see the "Fix status" section at the end. Nits remain open by choice.

Scope traced end to end:

- **Data/API**: `infra/db/migrations/0003_playlists.sql`, `infra/db/playlistQueries.ts`, `infra/db/types.ts`, `infra/worker/routes/playlists.ts`, `infra/worker/cache.ts`
- **Client hooks**: `infra/client/playlists/{playlistsApi,usePlaylists}.ts`, `tube/src/hooks/usePlaylists.ts`, `tube/src/lib/playlists.ts`
- **UI**: `tube/src/components/{PlaylistDetail,PlaylistDetailRoute,PlaylistsSection,PlaylistCard,PlaylistManagePanel,AddToPlaylistPopover,CreatePlaylistModal,MyLessonCard,LessonCard,LessonDetail}.tsx`
- **Playback**: `src/components/Editor.tsx`, `src/components/MediaControls.tsx`, `src/stores/playbackSettingsStore.ts`, `src/hooks/usePlaybackSettings.ts`, `src/core/src/useNextEditor.ts` (`selectHasEnded`), `src/core/src/machine/editorMachine.ts`, `src/core/src/machine/replayActions.ts` (`setRecording`)

---

## Findings (most severe first)

### 1. MEDIUM — An unpublished playlist member becomes unmanageable, and its position can be corrupted

Root cause: the owner's manage surface operates on the **public, published-only** view of the playlist.

- `PlaylistManagePanel.tsx:41` reads membership via `usePlaylist(playlist.slug)` → public `GET /api/playlists/:slug` → `getPlaylistBySlug` (`playlistQueries.ts:67-88`), which filters `lessons.status = 'published'`.
- `PlaylistManagePanel.tsx:54-57` then intersects with `publishedLessons` (already filtered in `PlaylistsSection.tsx:29`).
- `MyLessonCard.tsx:188-201` shows "Add to playlist" (the only other add/remove surface) **only when `isPublished`**.

Failure scenario: owner adds a published lesson to a playlist, later unpublishes the lesson.

- The membership row still exists (`removeLessonFromPlaylist` is never reachable for it): the lesson is invisible in the manage panel and has no "Add to playlist" popover, so **no UI can remove it from the playlist**.
- The My Library card badge (`PlaylistCard.tsx:93-96`) shows `lessonCount` from `listOwnedPlaylists`, which deliberately counts **all** members (`playlistQueries.ts:109-130`) — so the card says "3", the manage panel shows 2, with no explanation. The query comment says the owner should "notice and fix it", but there is nothing to fix it with.
- Worse: reordering while a hidden member exists rewrites positions `0..n-1` for the **visible subset only** (`PlaylistManagePanel.tsx:57`, `reorderPlaylistLessons` at `playlistQueries.ts:288-310`). The hidden row keeps its old position, which can now duplicate another row's position. When the lesson is re-published it resurfaces at an effectively arbitrary spot (ORDER BY position with ties), and `position` is no longer dense.

Suggested direction (not implemented): give the manage panel an owner-scoped membership read (e.g. `GET /playlists/:id/lessons` without the published filter, or include member ids+status in `/mine`), render unpublished members greyed out with Remove enabled; alternatively auto-remove memberships on unpublish. Server-side, make `reorderPlaylistLessons` rewrite positions for the full membership (see finding 5).

### 2. MEDIUM (verify at runtime) — Cold-load autoplay likely starts _silent_ playback; Editor comment claims it stays at 0

`Editor.tsx:113-137`: the autoplay effect calls `unlockAudioContext(ctx); ctx.resume().catch(...); play()`. On a cold page load there has been no user gesture, so `ctx.resume()` is rejected/ignored and the shared AudioContext stays `suspended` (`src/core/src/utils/audioContext.ts` only resumes on a later mousedown/touch/keydown/click).

But `play()` is an XState event, not an `HTMLMediaElement.play()` — the timeline actor and visual replay are not gated by the browser's autoplay policy. The guard comment ("playback stays at time 0 and FloatingPlayButton remains the visible fallback", `Editor.tsx:113-117`) assumes the whole playback is blocked; more likely the recording **plays visually with no audio**, and audio pops in mid-lesson (position sync unverified) at the user's first click.

Failure scenario: viewer with Autoplay enabled deep-links to `/learn/some-lesson` → lesson starts silently; either the audio never plays or it cuts in at an arbitrary point on first interaction.

Suggested direction: verify in a browser; if confirmed, gate the persisted-autoplay path on `isUnlocked` / `ctx.state === "running"` (the `autoplayOverride` continue-to-next path is fine — the context was unlocked by the earlier play gesture).

### 3. LOW/MEDIUM — Persisted Autoplay setting is inert on every surface that doesn't pass `recordingUrl`

`Editor.tsx:118,126`: `autoplayedForRef` starts as `undefined`, and the once-per-load guard is `if (autoplayedForRef.current === recordingUrl) return;`. When `Editor` is driven by `?url=` (or drag-drop) the `recordingUrl` prop is `undefined`, so `undefined === undefined` short-circuits **before the first autoplay ever fires**.

Failure scenario: `/code?readOnly=true&url=/foo.ne` (readOnly embeds — `CodeRoute.tsx:63` passes no `recordingUrl`). MediaControls renders the Autoplay switch (`recordMode` false, `MediaControls.tsx:593-614`), the user turns it on, it persists to localStorage — and never does anything on that surface.

Suggested direction: initialize the ref to a sentinel (`useRef<string | null>(null)` won't do since `recordingUrl` can be undefined — use a unique symbol/object), or key the guard on the loaded recording identity instead of the prop.

### 4. LOW — `autoplayOverride` survives refresh and back/forward; the code comment says it can't

`LessonDetail.tsx:36-38` claims "Router state isn't part of the URL, so a refresh or a direct deep link never force-plays". Direct deep link: correct. Refresh / back-forward: **incorrect** — React Router persists `location.state` in `history.state.usr`, which browsers restore across reloads and on back/forward traversal.

Failure scenario: auto-advance lands on lesson B with `state.autoplay = true`; the user pauses, later refreshes (or navigates away and comes Back) — the one-shot override re-force-plays regardless of the Autoplay setting. On refresh this also composes with finding 2 (unprompted silent playback).

Suggested direction: clear the state after consuming it (e.g. `navigate(".", { replace: true, state: null })` once autoplay has fired), or carry a nonce that's only honored once.

### 5. LOW — `reorderPlaylistLessons` trusts the client's id list

`playlistQueries.ts:288-310` + route at `playlists.ts:214-240`: ownership of the playlist is checked, but `lessonIds` is not validated against actual membership, completeness, or duplicates. Non-member ids silently no-op; a **partial** list leaves the untouched rows with stale positions that can collide with the rewritten `0..index` range (this is the server half of finding 1's corruption; it's also reachable by any stale client). Positions stop being dense and order becomes tie-dependent.

Suggested direction: derive the authoritative membership server-side, reorder the submitted ids first and append any members the client didn't mention, or reject lists that don't exactly match membership.

### 6. LOW (UX) — Playback speed and volume reset on every auto-advance

`replayActions.ts:85-93`: `setRecording` resets `timeline.speed` to 1 and `volume` to 1 on each load. A viewer watching a playlist at 1.5x/low volume gets reset on every "Continue to Next" hop — the exact flow where continuity is expected (YouTube preserves both). Autoplay/continueToNext already live in `playbackSettingsStore`; speed (and arguably volume) is the natural third resident.

---

## Nits / smaller observations

- **Unencoded slug interpolation**: `LessonDetail.tsx:31` and `LessonCard.tsx:27` build `?list=${listSlug}` / `/learn/${slug}` without `encodeURIComponent`. Safe today (server-generated `[a-z0-9-]` slugs; a hostile `?list=` just fails playlist resolution and disables playlist mode), but `findPlaylistBySlug` encodes on the way out — be consistent on the way in.
- **Toggling Autoplay mid-page starts playback immediately**: `autoplay` is a dep of the autoplay effect (`Editor.tsx:138-149`), so flipping the switch while paused at t=0 instantly plays. Arguably fine, but it makes the settings menu feel like a transport control.
- **Playlist fetch failure silently disables Continue to Next**: on `/learn/:slug?list=x`, if the playlist query errors, `playlistMode` is false — the toggle disappears and playback ends without advancing, with no retry surface (`LessonDetail.tsx:21-25`). Acceptable degradation, but invisible.
- **No cross-tab sync**: `playbackSettingsStore` reads localStorage once at module load; no `storage` event listener, so two tabs diverge (last writer wins). Fine at this scale.
- **Adjacent lessons sharing one `.ne` URL never autoplay the second**: the `autoplayedForRef` guard is keyed on `recordingUrl` (`Editor.tsx:126`), so a playlist containing two lessons that point at the same recording file won't autoplay the second hop. Obscure.
- **404s are never cached**: `cached()` (`cache.ts:49-50`) treats a stored `null` as a miss, so unknown playlist slugs hit D1 on every request. Same pre-existing pattern as lessons; only matters under abuse.
- **No "Up next" affordance**: auto-advance fires instantly at `hasEnded` with no countdown/cancel, and the lesson page shows no indication of what's next or that it's in a playlist (breadcrumb doesn't link back to the playlist). Product choice, noting for completeness.

## Checked and found correct

- `selectHasEnded` (`useNextEditor.ts:90-92`) requires the `playback.ended` state **and** `currentTime >= duration - ε`; `ended` is only reachable via `FINISHED` from `playing` (`editorMachine.ts:763-775`) — scrubbing to the end while paused cannot trigger auto-advance.
- `Editor.tsx:103-111` fires `onEnded` on the false→true edge only; the ref survives lesson-prop swaps, so a stale `hasEnded` from the previous recording can't double-advance during a navigation.
- `handleEnded` reads `continueToNext` via `getSnapshot()` at end time (`LessonDetail.tsx:29`) — no stale-closure risk; a stale/foreign `?list=` degrades to non-playlist mode; last lesson stops cleanly (no wraparound).
- `setRecording` resets `currentTime` to 0 in the same transition that swaps the recording, so the `selectLiveTime !== 0` autoplay guard has no load race.
- Server-side: every mutation checks ownership; only the owner's own **published** lessons are addable; the public read re-filters `status='published'` on every request, so unpublishing genuinely removes a lesson from the public playlist page; add/remove/reorder use atomic `db.batch`; `MAX(position)+1` is computed inside the INSERT statement (no read-modify-write race under D1's serialized writes); duplicate add maps the UNIQUE violation to 409; Upstash cache is invalidated on every mutation and its failures degrade to D1.
- Client cache: the `["playlists"]` prefix invalidation covers `/mine`, per-lesson membership, and the detail query; TanStack v5 awaits the returned `invalidateQueries` promise, so `isPending` covers the refetch window in the manage panel.
- Route ordering (`/mine` before `/:slug`; `/learn/playlist/:slug` vs `/learn/:slug`) is correct, and the SPA-fallback/HTML-content-type guard in `findPlaylistBySlug` handles dev-without-worker.

## Fix status (2026-07-10)

1. **FIXED** — new owner-scoped `GET /api/playlists/:id/lessons` (`getOwnedPlaylistLessons`, all members incl. unpublished, position order) + infra `usePlaylistLessons` (staleTime 0; lessons mutations don't invalidate playlist keys). `PlaylistManagePanel` now reads it directly — no more slug reconciliation against `publishedLessons` — and renders unpublished members greyed with a "Draft" tag, Remove enabled; reorder submits the full membership. The `lessons` prop threading through `MyLibraryGrid` → `PlaylistsSection` → panel was removed.
2. **FIXED** — `Editor`'s autoplay effect now skips the persisted-setting path when the recording has audio and the shared AudioContext isn't `running` (cold load, no gesture) — FloatingPlayButton stays the entry point instead of a silent visual replay. Audio-less recordings still autoplay. `autoplayOverride` is exempt: post-fix-4 it only exists in-session, after a play gesture unlocked the context. The once-per-load ref is only consumed when play() actually fires.
3. **FIXED** — `autoplayedForRef` initializes to an `AUTOPLAY_NOT_FIRED` sentinel symbol instead of `undefined`, so `?url=`/drag-drop surfaces (where `recordingUrl` is undefined) autoplay once per mount instead of never.
4. **FIXED** — `LessonDetail` scrubs the flag from the persisted history entry (`history.replaceState` with `usr: null`, preserving the router's `key`/`idx`) after latching it. Deliberately bypasses a router-level replace-navigation, which would flip `autoplayOverride` back to false before the next recording finishes loading and kill the autoplay it exists to trigger. Refresh and back/forward no longer force-play.
5. **FIXED** — `reorderPlaylistLessons` now treats the submitted list as a preference: filters to actual members, dedupes, and appends unmentioned members in their current relative order, so positions always come out dense over the full membership.
6. **FIXED** — `setRecording` carries `timeline.speed` and `timeline.volume` across loads (the audio child spawns from these context values, so they reach it). Covers the common auto-advance path where the machine instance survives; a full remount still starts at defaults — promoting speed into `playbackSettingsStore` remains possible follow-up.
