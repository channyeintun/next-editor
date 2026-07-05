# UX Spec: Upload Lesson modal (post-recording)

## Intent

The user just finished recording a coding session in `/code`. Today the only
options are Export (.ne file) or Download (zip) — both dead ends for sharing.
The user's actual goal: **"put this somewhere other people can watch it."**
They expect: stop recording → a clear, low-friction path to publish, without
losing the recording if they get interrupted (sign-in, a closed tab, a typo).

## Trigger

`currentRecording` transitions from `null` → `Recording` (i.e. `stopRecording()`
was just called) — the exact moment `MediaControls` already starts showing the
inline playback view. The modal opens automatically **once** per stop, as a
suggestion, not a takeover.

**Rule: this is dismissible, not a gate.** Recording is already safe in
IndexedDB before the modal exists. Closing it (X, click-outside, Escape) always
returns to the normal post-recording editor screen — the recording plays back,
Export/Download still work, nothing is lost. There is no "are you sure"
confirmation for closing, because closing destroys nothing.

Does **not** reappear automatically after being dismissed for that recording.
A small persistent affordance covers "changed my mind" (see Discoverability
below) — no auto-popup nagging.

## Happy path

1. User stops recording. Modal slides in: "Share this recording?" with a
   title field (pre-filled, see Defaults) and a primary "Upload" button.
2. Signed in already → fills in title (or accepts the default), optionally
   description/tags, hits Upload.
3. Progress state: uploading .ne (fast) then media (slower), a single combined
   progress bar with a byte-count label, not two bars — the user doesn't care
   which file is moving.
4. Success state: "Saved as a draft" + a copyable `/learn/:slug` link + a
   **Publish now** button + "Keep as draft" (closes, reachable later from "My
   Lessons").
5. If they hit Publish now: brief inline confirmation, modal closes, done.

## States

- **Signed out** — see dedicated flow below (this is the most complex state,
  because of the redirect round-trip).
- **Form (signed in)** — title/description/tags/thumbnail, primary CTA.
- **Uploading** — determinate progress, cancellable (see edge cases).
- **Success (draft saved)** — link + Publish/keep-as-draft choice.
- **Success (published)** — reachable only via the Publish action from the
  draft-saved state, not a separate upload outcome.
- **Error — upload failed** (network, R2 signing, size limit) — form state
  preserved, retry in place, no re-typing.
- **Error — not signed in anymore** (session expired mid-flow) — treated the
  same as the initial signed-out state, but _after_ they've already typed a
  title/description (see edge cases — must not lose that text).
- **Empty/first-time vs. returning** — no meaningful difference; every
  recording is a fresh form. (No "don't show this again" — see Deliberately
  NOT doing.)

## The signed-out flow (the trickiest part)

1. Modal opens in a **lightweight signed-out state**: recording thumbnail +
   duration + one line ("Sign in to save and share this recording") + a single
   "Sign in with Google" button. **No metadata form yet** — asking someone to
   fill in a title before they've even committed to sharing is friction for
   nothing; save that step for after sign-in.
2. Click "Sign in with Google" → before navigating away, persist a **resume
   intent** to IndexedDB (not localStorage/sessionStorage — the recording
   itself already lives in IndexedDB, so this is one storage system, not two):
   `{ recordingId, returnTo: "/code" }`. This is a pointer, not a copy — the
   recording blob itself never duplicates.
3. Full-page redirect to Google, user signs in, redirected back to `/code`.
4. On mount, `/code` checks for a resume intent. If present _and_ the
   recording it points to still exists in IndexedDB _and_ the user is now
   signed in: reopen the modal, already past the sign-in step, straight into
   the metadata form (title still empty — they hadn't typed one yet, since
   step 1 deliberately didn't ask). Clear the resume intent either way (used
   once).
5. If the recording no longer exists (cleared storage, different device) or
   sign-in didn't actually complete (they backed out on Google's screen): drop
   the resume intent silently, land on a normal `/code` with no error banner —
   there's nothing to apologize for, they just didn't finish an optional
   action.

**Rule for the redirect boundary:** anything typed _before_ the redirect must
not vanish. Since step 1's signed-out state has no form fields, there is
nothing to lose — this is a deliberate simplification, not a gap (see edge
cases below for what happens if a user backs out _after_ starting the form).

## Interactions & edge cases

- **Close/Escape/click-outside while uploading**: allowed, not blocked. A
  confirm ("Cancel upload?") only if the upload is >50% done or media (not
  just the tiny `.ne`) has started — below that threshold, just cancel
  silently, it's not worth interrupting them to ask. The recording is never
  at risk either way; this only aborts the network calls.
- **Backs out of Google's sign-in screen (never returns to /code):** no
  resume intent is consumed; the recording sits untouched in IndexedDB. If
  they later click "Start creating" → record again → stop, a **fresh** modal
  opens for the _new_ recording. The old one's "want to upload?" moment has
  simply passed — not resurrected via a nag, reachable manually if a "my
  local recordings" surface exists later (out of scope for v1, see below).
- **Session expires between opening the form and hitting Upload** (stale
  cookie, signed out in another tab): Upload button click gets a 401 back →
  don't lose the typed title/description. Switch to a compact inline banner
  _inside the still-open form_ ("Your session expired — sign in to
  continue") with a Sign-in button that does the same resume-intent dance,
  but this time the resume intent also carries the **already-typed form
  values**, not just the recording pointer — this is the one case where
  something typed does cross the redirect, so it must survive it.
- **Empty title, hits Upload**: inline validation on the field itself, don't
  submit — title is the one required field. Auto-focus it. Don't disable the
  Upload button preemptively (disabled buttons that don't explain themselves
  are a worse UX than a clear inline error after a clear click).
- **Title/description at the character limit**: soft-cap with a counter that
  only appears near the limit (last ~20%), not from character zero — chrome
  you don't need most of the time.
- **Duplicate clicks on Upload**: button disables + shows "Uploading…" the
  instant it's clicked, before any network round-trip, so a slow connection
  can't produce a double-submit.
- **Network drops mid-upload**: error state, retry re-uses the same draft
  attempt rather than starting over from a blank R2 key (avoid orphaned
  partial objects) — retry resumes, doesn't restart cold.
- **Very long recording / large media file**: progress bar is the main
  signal; if it's going to take a while, say so once ("Large file — this may
  take a minute") rather than a silent stall that reads as broken.
- **Copy link button** (success state): standard copy-to-clipboard with a
  2-second "Copied" confirmation, not a separate modal.
- **Keyboard**: Escape closes at any dismissible state (not while a "cancel
  upload?" confirm is itself open — Escape there cancels _that_ confirm, one
  level at a time). Enter in the title field does not submit the whole form
  (avoid an accidental early upload before description/tags are considered;
  match the app's existing modals, which use explicit Save/Cancel buttons,
  not Enter-to-submit).

## Defaults & smart behavior

- **Title pre-fill**: derive from context if available (e.g. the workspace's
  project name or a timestamp like "Recording — Jul 5, 2:14 PM") rather than
  a blank required field — a default the user can override beats an empty
  field they must fill.
- **Duration**: read from the `Recording` object directly, never re-derived
  or user-entered.
- **Thumbnail**: auto-generate from a recording frame (e.g. first meaningful
  editor frame) as the default, shown immediately in the form so it doesn't
  feel like a missing/broken image; an explicit small "Change" affordance
  lets them upload their own. Never block Upload on thumbnail choice.
- **Tags**: optional, no default — inventing fake tags would be worse than
  none.
- **Draft, not auto-publish**: the upload action itself never makes the
  lesson public. This is a safety default, not just a lifecycle rule — it
  means a typo or an unfinished description is never visible to anyone
  before the user explicitly says "Publish."

## Progressive disclosure

- **Default visible fields**: title only, prominently required; description
  and tags visible but clearly optional (lighter labels, no asterisk).
  Thumbnail shown as a preview strip, not a whole separate step.
- **Not shown unless relevant**: the "session expired, sign in again" banner
  only appears on that specific failure — it's not a permanently-visible
  auth-status indicator inside the modal (the Navbar's `AuthMenu` already
  covers "am I signed in" globally; duplicating that here would be clutter
  for the 99% case where the session is fine).

## Consistency

Reuses the app's existing modal grammar exactly (`EditorHeader.tsx`'s
Environment/Media-Links modals): `fixed inset-0 bg-[#0b0d12]/62 backdrop-blur`
overlay with click-outside-to-close, `max-w-xl rounded-2xl border
border-slate-800 bg-[#151821]` panel, `bg-[#11141c]` inputs, the same
Cancel-(text)/Save-(solid button) footer pattern. Copy link / success state
borrows the pill-button style from `Navbar`/`tube` (`rounded-full border
border-white/10 bg-white/10 ... hover:bg-white hover:text-slate-950`) since
that's the vocabulary the _destination_ (`/learn`) already uses — the modal
is the handoff point between the two visual contexts, so it's reasonable for
its success state to start speaking Tube's language.

## Discoverability

The modal is the primary path, shown automatically once per recording. For
someone who dismissed it and changes their mind, add a "Share…" entry to
`EditorHeader`'s existing export menu (next to Export/Download) that reopens
the same modal against the current `currentRecording` — an existing,
already-discoverable menu, not a new hidden gesture.

## Deliberately NOT doing (v1)

- **No "don't show this modal again" setting.** One extra decision per
  recording is cheap; a hidden preference that later confuses "why didn't it
  pop up" is not worth avoiding one click.
- **No multi-recording / batch upload management UI** ("my local
  recordings" library of everything ever recorded). Out of scope — the
  modal only ever concerns the recording that was just stopped.
  Signed-in "My Lessons" (listing already-uploaded drafts/published lessons)
  is separate, existing Phase-3 scope, not this modal.
- **No inline video/waveform scrubbing inside the modal.** The user already
  saw the recording play back in the editor right before this; the modal
  doesn't need to re-preview it, just show a static thumbnail + duration.
- **No collaborative/team upload options** (assigning to an org, choosing
  visibility beyond draft/published). Single-owner only, matches "any Google
  account can create" from the architecture doc.
- **No editing already-published lesson metadata from this modal.** This
  component is upload-time only; editing a live lesson is a distinct
  "manage my lessons" surface, not in scope here.
- **No client-side file-size hard limit UI beyond a clear server error.**
  Guessing at a limit in the client just to show a friendlier message before
  the server's real limit is speculative complexity for v1 — a clear error
  message on the real rejection is enough.
