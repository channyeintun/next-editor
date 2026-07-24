# Review — core, recording/replay machines, and the studio lesson pipeline

**Date:** 2026-07-25 · **Branch:** `main` @ `e48efad` · **Machine:** macOS workstation
**Scope requested:** `src/core` (incl. the recording and replay state machines) and
`src/studio` (agent lesson production, incl. its agent skills).
**Mode:** review only — nothing in this pass was changed.

Continues the ID space of `docs/studio-agent-skill-review-2026-07-23.md`
(STUDIO-01…06, SKILL-01…02, all of which read as landed). Everything below is new.

## Verdict

The architecture is in good shape. The capture/replay split is genuinely clean —
`captureActions.ts` / `replayActions.ts` as plain functions wired through `setup()`,
per-track replay modules over one shared cursor core, an append-only mutable session
buffer with an explicit `sessionRevision` contract. The studio pipeline is unusually
disciplined for generated content: everything is seeded and materialized at compile
time, the compiled plan re-enters the same validator a hand-written plan would, and QA
gates the _decoded_ `.ne` rather than the in-memory recording. Comments explain _why_,
not _what_, and most of them are load-bearing. 370 tests across `src/core` + `src/studio`
pass in 5.7s.

Two findings are worth acting on soon:

- **CORE-01 (High)** — streaming playback replays whiteboard and preview tracks against
  a stale index cache. Reproduced: the whiteboard freezes, the preview panel is handed
  an empty state on seek, and one code path throws a `TypeError` mid-playback.
- **STUDIO-07 (High)** — actions that share an `afterAction` predecessor are performed
  in **reverse** authored order. Every shipped lesson has such a pair; today they are
  two independent assertions so nothing breaks, but the ordering guarantee the docs
  promise is not the one the compiler produces.

The rest are correctness edges, dead code, and one distribution-hygiene gap in the
skill bundle.

---

## Core — recording and replay machines

### CORE-01 — High — Streaming playback replays whiteboard/preview against a stale index cache

**Where:** [replayState/whiteboard.ts:36](src/core/src/machine/replayState/whiteboard.ts:36),
[replayState/preview.ts:22](src/core/src/machine/replayState/preview.ts:22),
[replayActions.ts:187](src/core/src/machine/replayActions.ts:187)

Both track modules memoize a fully-folded `retainedStates[]` in a
`WeakMap<Event[], Index>` keyed on the events array, built once at first access from
whatever length the array had then.

Streaming playback mutates those same arrays **in place**:

```ts
// replayActions.ts:187 — appendRecordsInPlace
const target = current ?? [];
for (const record of incoming) target.push(record);
```

`APPEND_RECORDING_DELTA` is live in production — `useUrlLoader.ts:376` sends one per
progressive-decode interval while the user is already playing. `normalizeRecordingData`
rebuilds only `frames`; every other track array keeps its identity, so the cached index
stays frozen at its pre-stream length while `findTimedEventIndexAtOrBefore` happily
returns indices past its end.

Reproduced directly against the shipped modules:

```
whiteboard t=0    -> index 0, 1 element                       (cache built here)
whiteboard t=1000 -> index 1, stateToApply UNDEFINED          (scene freezes)
whiteboard t=1950 -> THREW: undefined is not an object (evaluating 'baseState.elements')
preview seek t=1000 -> index 1, retainedState {}              (every field lost)
```

Three distinct consequences:

1. **Whiteboard freezes.** `retainedStates[nextIndex]` is `undefined`, so
   `applyWhiteboardEventsAtTime` skips on the falsy `stateToApply` check
   ([replayActions.ts:997](src/core/src/machine/replayActions.ts:997)) and the board
   holds the last pre-stream scene for the rest of playback — silently.
2. **Whiteboard throws.** `getInterpolatedState` dereferences
   `baseState.elements.map(...)` on that same `undefined`
   ([whiteboard.ts:187](src/core/src/machine/replayState/whiteboard.ts:187)). A tick
   landing in the 150 ms interpolation window of a streamed-in event raises a
   `TypeError` from inside an XState action.
3. **Preview is blanked.** The seek path does
   `clonePreviewReplayState(retainedStates[nextIndex])` = `{...undefined}` = `{}`
   ([preview.ts:174](src/core/src/machine/replayState/preview.ts:174)), and
   `applyPreviewState({})` drops `isOpen`, `mode`, `size`, `content`, `route`.

The window closes when the final `EXTEND_RECORDING` swaps in fresh decoder arrays, so
this only bites _during_ the download — which is exactly the streaming-playback feature.

**Worth noting:** the codebase already solves this correctly one file over.
`latestEditorModelBoundaryTime` ([replayActions.ts:67](src/core/src/machine/replayActions.ts:67))
caches per array _and extends the cache to the requested index_ precisely because
"recording streams append events to the same array". The two replayState caches predate
or missed that lesson.

**Fix direction:** extend rather than rebuild — or, minimally, invalidate when
`retainedStates.length !== events.length`. Extending is strictly better here since both
folds are prefix-computable.

### CORE-02 — Medium — Chat replay re-folds up to 200 deltas on every advancing tick

**Where:** [replayState/chat.ts:27](src/core/src/machine/replayState/chat.ts:27)

`getChatReplayResult` calls `foldChatEventsUpTo` whenever `nextIndex !== lastAppliedIndex`
— i.e. on every tick that crosses a chat event, not only on seeks. The fold walks back to
the nearest checkpoint and replays every delta forward from there.

Checkpoints are emitted every ~200 deltas or at run completion
([chatRecording.ts:8](src/agent/chatRecording.ts:8)), so a single advancing tick can
replay up to 200 deltas, and each `content` delta runs a WASM `applyContentDelta` against
the growing message text ([chatDelta.ts:64](src/core/src/utils/chatDelta.ts:64)). Total
work over a playback is ≈ `n × interval/2`; for a 2 000-delta conversation that is a few
hundred thousand delta applications, spiking to ~200 in one frame.

The module comment ("Seeking backward re-folds from the preceding checkpoint instead of
incrementally undoing deltas") describes the intent correctly, but forward playback —
the common case — takes the same expensive path. Retaining the last folded state and
applying just the new delta when `nextIndex === lastAppliedIndex + 1` and that event is
not a checkpoint would make forward playback O(1) per tick with no format change.

### CORE-03 — Medium — `keyframeIndexCache` has the same staleness; correctness survives by accident

**Where:** [frameDelta.ts:31](src/core/src/utils/frameDelta.ts:31)

`findNearestKeyframeIndex` memoizes keyframe indices in a `WeakMap<DeltaFrame[], number[]>`
keyed on the frames array — which `appendRecordsInPlace` also mutates in place. After a
streamed append the cache misses every new keyframe and returns an older one.

This does **not** currently corrupt playback, but only because `reconstructFrameAtIndex`
re-bases on any keyframe it walks through:

```ts
// frameDelta.ts:776
if (isKeyframe(frame)) {
  current = frame;
} // silently rescues the stale lookup
```

So the observable cost is an unbounded delta walk (potentially the whole streamed tail)
on every seek instead of a bounded one. It is one refactor away from being a real bug,
and it should be fixed alongside CORE-01 with the same extend-the-cache approach.

### CORE-04 — Medium — The 2 s finalize watchdog can silently drop the microphone blob

**Where:** [editorMachine.ts:674](src/core/src/machine/editorMachine.ts:674)

```ts
stoppingRecording: {
  exit: [stopChild("audioRecorder"), stopChild("cameraRecorder")],
  after: { 2000: { target: "loading", actions: ["finalizeRecording", "notifyRecordingStop"] } },
}
```

`AUDIO_RECORDING_STOPPED` is handled only inside `recording` and `stoppingRecording` — it
is _not_ one of the root-level handlers (unlike the screen events, which are, with a
comment explaining exactly why). If `MediaRecorder.stop()` takes longer than 2 s, the
watchdog fires, `exit` kills the audio child, and the blob never arrives.

The resulting recording is silently silent: `finalizeRecording` sees `audio.blob === null`,
so `Recording.audioBlob` is `undefined` while `buildTrackMetadata` still advertises an
`audio` track (`hasAudio` is true from the timeslice fragments). `getPlaybackAudioState`
then returns `null` and playback has no narration, with no error surfaced anywhere.

Cheapest hardening: promote `AUDIO_RECORDING_STOPPED` (and `AUDIO_RECORDING_CHUNK`) to the
machine root the way the screen events already are, so a late blob is still stored.

### CORE-05 — Low — Dead `isSeeking` branches in preview and slide replay

**Where:** [preview.ts:185](src/core/src/machine/replayState/preview.ts:185),
[slide.ts:112](src/core/src/machine/replayState/slide.ts:112)

Both functions `return` early inside `if (isSeeking) { … }`
([preview.ts:163](src/core/src/machine/replayState/preview.ts:163),
[slide.ts:101](src/core/src/machine/replayState/slide.ts:101)), so everything below is
reachable only when `isSeeking === false`. Yet the code below keeps testing it:

```ts
let nextIndex = isSeeking ? -1 : lastAppliedIndex;        // preview.ts:185 — always the else
if (!isSeeking) { appliedStates.push(...); }              // preview.ts:207 — always true
if (isSeeking && retainedState) { appliedStates.push(…) } // preview.ts:215 — never runs
if (isSeeking) { lastMatchedEventIndex = index; }         // slide.ts:132  — never runs
if (isSeeking && lastMatchedEventIndex >= 0) { … }        // slide.ts:145  — never runs
```

Not a behaviour bug, but it reads as though one loop handles both modes, which makes the
actual seek semantics harder to audit and invites a future fix to be applied to the dead
half. Deleting the dead guards would shorten both functions meaningfully.

### CORE-06 — Low — Slide replay is O(n²) while its neighbours precompute

**Where:** [slide.ts:31](src/core/src/machine/replayState/slide.ts:31)

```ts
const relevantEvents = slideEvents.slice(0, eventIndex + 1).reverse();
```

Allocated fresh per applied event, and the non-seek loop applies every newly passed
event. Preview and whiteboard both precompute a cached `retainedStates` index for exactly
this shape of problem; slide is the odd track out. Slide tracks are small enough that this
doesn't hurt today — worth flagging as a consistency gap rather than a performance
emergency.

### CORE-07 — Low — `finalizeRecording` resets six replay cursors but not the chat one

**Where:** [captureActions.ts:799](src/core/src/machine/captureActions.ts:799)

The reset block covers `frame`, `previewEvent`, `previewPatchBatch`, `slideEvent`,
`workspaceEvent`, `runtimeEvent`, and `whiteboardEvent` — but omits
`lastAppliedChatEventIndex`, which every other reset site
(`setRecording`, `seekToTime`, `resetPlayback`, `invalidateAppliedPlaybackState`,
`detachPlaybackWorkspace`, `clearRecording`) does include.

Harmless today: `finalizeRecording` always targets `loading`, whose `onDone` runs
`setRecording`, which resets all eight. That also makes the whole block redundant. Either
delete it or complete it — as written it reads as an exhaustive list that quietly isn't.

### CORE-08 — Low — `getWorkspaceReplayResult`'s `getCurrentSnapshot` branch is test-only

**Where:** [replayState/workspace.ts:120](src/core/src/machine/replayState/workspace.ts:120)

```ts
const snapshot = currentSnapshot !== undefined ? currentSnapshot : (getCurrentSnapshot?.() ?? null);
```

Production always passes `currentSnapshot`
([replayActions.ts:888](src/core/src/machine/replayActions.ts:888)); the only callers of
the lazy branch are `replayState.test.ts:598` and `:612`. It's a public parameter whose
sole purpose is to let two tests observe call timing.

---

## Studio — agent lesson production

### STUDIO-07 — High — Actions sharing one `afterAction` predecessor perform in reverse authored order

**Where:** [script/compile.ts:207](src/studio/script/compile.ts:207)

The `afterAction` fixpoint loop iterates `pending` **backwards** and pushes each resolved
entry onto `authored` as it goes:

```ts
for (let i = pending.length - 1; i >= 0; i--) {
  …
  authored.push(entry);
  pending.splice(i, 1);
}
```

Siblings that share a predecessor all resolve in the same pass, so they land in `authored`
in reverse authored order. They also all get the _same_ `at` (runtime/preview/expect
actions have zero modelled busy time), and both subsequent sorts — `authored.sort` and the
`planActions` sort, whose tiebreak only separates `cursor.moveTo` from real actions — are
stable. The reversal therefore survives all the way into the plan, and the Performer
executes plan order strictly sequentially.

Verified by compiling a probe script through the real pipeline:

```
authored order : run, AAA-first-authored, BBB-second-authored, CCC-third-authored
performed order: cursor-run@0, run@675, CCC-third-authored@675, BBB-second-authored@675, AAA-first-authored@675
```

**Every shipped lesson hits this.** All 20 of `src/studio/scripts/*.yaml`, plus the Go
fixtures, pair `expect.output` and `expect.file` on `{ afterAction: run }`, e.g.
[rust-borrow.yaml:215](src/studio/scripts/rust-borrow.yaml:215). Today both are pure
assertions with no ordering requirement between them, so no lesson is currently wrong —
but nothing warns an author that the guarantee is inverted. The moment someone anchors a
`preview.click` and an `expect.output` to the same predecessor, expecting the wait to gate
the click, they get the opposite.

Chains (`A → B → C`) resolve one per pass and are unaffected.

**Fix direction:** iterate `pending` forward and remove resolved entries after the pass, or
carry each action's authored index and use it as the final stable tiebreak in both sorts.

### STUDIO-08 — Medium — An action-less lesson fails with a raw `TypeError`, not a readable schema error

**Where:** [plan.ts:751](src/studio/plan.ts:751)

Zod v4 runs `.superRefine` even when a _continuable_ inner check fails. Confirmed against
the installed version: a `z.array().min(1)` violation still invokes the object refinement
with `actions: []`. `studioPlanSchema`'s refinement then does, unguarded:

```ts
const lastAction = plan.actions[plan.actions.length - 1];
if (lastAction.at >= plan.narration.expectedDurationMs) { … }
```

A LessonScript with scenes but no actions is fully schema-valid (`actions` defaults to `[]`
at [schema.ts:203](src/studio/script/schema.ts:203)) and compiles to an empty action list.
Confirmed against the real schema:

```
parseStudioPlan(actions: []): TypeError: undefined is not an object (evaluating 'lastAction.at')
```

`compileLessonScript` catches it and wraps it, so an author who writes a narration-only
lesson — a perfectly reasonable first draft — gets:

> Compiled plan failed validation — adjust the script's marks/offsets: undefined is not an
> object (evaluating 'lastAction.at')

which points at the wrong thing entirely. This is the one error path that the
agent-authoring loop is most likely to hit on a first attempt, and it is the least
actionable message in the system. (`plan.ts:670` would likewise throw outright on a
non-array `actions`.)

**Fix direction:** early-return from the refinement when `plan.actions.length === 0`, and
give `lessonScriptSchema` an explicit "a lesson needs at least one action" issue.

### SKILL-03 — Medium — The distributed skill zip is stale and nothing regenerates or checks it

**Where:** [scripts/build-lesson-script-skill.ts:218](scripts/build-lesson-script-skill.ts:218),
[lessonScriptSkillBundle.test.ts:274](src/studio/lessonScriptSkillBundle.test.ts:274)

The generator's own docblock promises the bundle is generated "instead of hand-maintaining
a fork" — but `buildBundle()` emits only three of the five bundle files
(`references/lesson-script-authoring.md`, `references/studio-persona.md`,
`examples/rust-borrow.yaml`). `share/lesson-script-skill/SKILL.md` and `README.md` are
hand-maintained forks, and `share/lesson-script-skill.zip` — the artifact actually handed
to external users — is produced by hand and gitignored.

The on-disk zip is 3 days behind the directory. Diffing it:

- `SKILL.md` in the zip is **missing the entire `editor.select` section** and the
  "Studio automatically reserves two quiet seconds" rule — the very rule
  `lessonScriptSkillBundle.test.ts:263` asserts must be present in the distributed skill
  (the test reads the _directory_, so this passes while the shipped zip lacks it).
- `examples/rust-borrow.yaml` in the zip predates the `editor.select` scenes entirely and
  still pins `latencyMs: 2000` rather than the tuned `600`.

So an external agent working from the zip is taught an older action catalog than the one
the importer accepts, and is missing the guidance about not manufacturing recording
buffers — a regression of the same class as SKILL-01.

**Fix direction:** derive `SKILL.md` and `README.md` from the in-repo skill through the
same anchored-replacement transform used for the references, emit the zip from
`buildBundle()`, and cover all five files plus the archive in `--check` and in the
contract test.

### SKILL-04 — Medium — The skill mandates fixing an advisory check with known false positives

**Where:** [.claude/skills/lesson-script/SKILL.md:44](.claude/skills/lesson-script/SKILL.md:44),
[share/lesson-script-skill/SKILL.md:54](share/lesson-script-skill/SKILL.md:54),
[script/critic.ts:48](src/studio/script/critic.ts:48)

Both skills instruct the agent to _always_ fix `register.read-aloud`. That check flags any
uncontracted form in `UNCONTRACTED_FORMS`, matched on bare word boundaries — including:

```ts
"you have": "you've",
"we have":  "we've",
"has not":  "hasn't",
```

"we have to name the owner" and "you have three files" are correct, plain English. Applying
the suggested contraction yields "we've to name the owner" / "you've three files" —
archaic or wrong, and directly against the persona guide's own plain-English-for-a-global-
audience rule (also recorded in memory as a standing constraint). A mandatory-fix
instruction on an advisory, false-positive-prone lint pushes agents to degrade narration
in order to clear a note.

Two smaller edges in the same check:

- The banned-phrase loop `break`s after the first (longest) match
  ([critic.ts:154](src/studio/script/critic.ts:154)), so a scene containing several banned
  phrases reports one. An agent told to "fix banned phrases" fixes one, re-runs, finds
  another — an avoidable round trip.
- `"simply"`, `"easy"`, `"easily"` are broad enough to fire on legitimate prose.

**Fix direction:** either narrow the lexicon (drop the `have` forms, or require the match
not to be followed by `to`/a bare infinitive), or soften the skill instruction to
"fix unless the contraction reads wrong in context". Reporting all banned phrases per
scene is a one-line change.

### STUDIO-09 — Low — Two of the three `checks` types are no-ops, and the only real gate is opt-in

**Where:** [script/schema.ts:207](src/studio/script/schema.ts:207),
[script/compile.ts:455](src/studio/script/compile.ts:455)

`scriptCheckSchema` accepts `recording.decodes`, `runtime.noErrors`, and `timing.p95Ms`.
The compiler reads only the timing entry into `plan.gates`; the other two are dropped.
They are also always-on inside `runArtifactChecks` regardless of whether the script
declares them — so declaring them is decorative, and an author reasonably concludes that
omitting them disables them.

Conversely, `checks` defaults to `[]`, so omitting `timing.p95Ms` silently drops the only
configurable gate — while both skills say "always include" it and nothing enforces that.
The result is a knob that does nothing when set and matters only when _unset_, which is the
opposite of what the schema suggests.

**Fix direction:** reject the two no-op check types (or make them actually toggle their
gates), and either default the timing gate on or fail compilation without it.

### STUDIO-10 — Low — Live whiteboard z-order can diverge from the replayed recording

**Where:** [driver.ts:906](src/studio/driver.ts:906),
[replayState/whiteboard.ts:56](src/core/src/machine/replayState/whiteboard.ts:56)

The driver publishes the live scene as
`[...current.elements.filter(not upserted), ...upserts]` — a re-upserted element **moves to
the end** of the array. The replay fold rebuilds through a `Map`, so an upsert of an
existing id **keeps its original slot**. The `compareElementIndices` sort that is supposed
to reconcile the two is a no-op here, because `buildWhiteboardElement`
([whiteboardAssets.ts:38](src/studio/whiteboardAssets.ts:38)) never sets `index`, and the
comparator returns `0` when either side is undefined.

Excalidraw treats array order as the source of truth, so a lesson that applies the same
whiteboard asset twice renders with a different z-order live than on replay. Narrow (it
needs a repeated `upsertIds` entry), but it is a live-vs-replay divergence in a system
whose whole QA story is that the recording matches the performance.

### STUDIO-11 — Low — Driver-supplied event timestamps are always discarded

**Where:** [driver.ts:804](src/studio/driver.ts:804), `:840`, `:868`, `:895`

`showSlide`, `closeSlide`, `applyWhiteboard`, and `expectPreview` all build events with
`timestamp: performance.now()` — a raw high-resolution clock reading, not a
session-relative offset. Every one is overwritten by the capture appenders with
`getRecordingTimestamp(session)`
([recordingSession.ts:34](src/core/src/machine/recordingSession.ts:34)).

Harmless as written, but it reads exactly like the wall-clock/recording-clock mixup the
`RecordingSession.startedAt` docblock warns about, and it would become one the moment an
appender stopped overwriting. Passing `0` with a comment, or having the appenders take the
event without a timestamp field, would remove the trap.

### STUDIO-12 — Low — `CSS.escape` used to escape an attribute _string_ value

**Where:** [targets.ts:43](src/studio/targets.ts:43)

```ts
const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
return document.querySelector(`[${STUDIO_TARGET_ATTRIBUTE}="${escaped}"]`);
```

`CSS.escape` escapes _identifiers_; the result is interpolated into a **quoted** attribute
selector, where CSS string-escaping rules apply instead. It happens to work for every id in
use (`file:src/main.rs` → `file\:src\/main\.rs`, which the string tokenizer unescapes back
to the original) but it is the wrong escape for the context and relies on that coincidence.
The correct escape for a quoted attribute value is `value.replace(/["\\]/g, "\\$&")`.

---

## What is working well

Worth recording so it doesn't get refactored away:

- **The capture/replay split.** Keeping action bodies as plain functions in
  `captureActions.ts` / `replayActions.ts` and wiring them in `editorMachine.ts` so
  `setup()` can still infer types is a genuinely good pattern — the machine file reads as
  state wiring, and the action bodies are unit-testable.
- **The append-only session invariant** is documented once, on `RecordingSession`, and every
  appender's return-`false`-on-dedupe contract lines up with it. `sessionRevision` is the
  right escape hatch for reference-equality selectors.
- **Deliberate non-resets are commented with their reason.** The three sites that keep
  `lastAppliedWorkspaceEventIndex` all explain the relative-delta unbounded-growth failure
  they are avoiding. That is what stops the next person "fixing" the asymmetry.
- **QA gates the decoded artifact, not the in-memory recording** — and `runArtifactChecks`
  returns the recording it vouched for so the manifest hash and repeatability semantics
  can't be derived from anything else. That is the right invariant, stated in the right
  place.
- **`syncPlaybackAudio`** collapsing four drifting spawn/seek/rate/volume/play sequences
  into one options-driven helper is a clean de-duplication of a real past bug class.
- **The skill's Chrome-verification rule** (never headless, never a background dev server)
  is stated in both the skill and the contract test, which is the right way to make a
  workflow constraint stick.

---

## Verification performed

| Check                                                                   | Result                                                                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `npx vp test run src/studio src/core`                                   | 43 files, **370 tests passed**, 5.66s                                                                                   |
| Replay index-cache staleness probe (whiteboard + preview, real modules) | Reproduced all three failure modes in CORE-01                                                                           |
| `compileLessonScript` sibling-`afterAction` order probe                 | Reproduced the reversal in STUDIO-07                                                                                    |
| `parseStudioPlan({ actions: [] })` against the real schema              | Reproduced the `TypeError` in STUDIO-08                                                                                 |
| Zod v4 `superRefine`-after-continuable-failure behaviour                | Confirmed: refinement runs with the partially-valid value                                                               |
| `share/lesson-script-skill.zip` vs `share/lesson-script-skill/`         | Confirmed stale: `SKILL.md`, `README.md`, `examples/rust-borrow.yaml` all differ                                        |
| `afterAction` usage across all shipped scripts + fixtures               | 20/20 shipped scripts have a sibling pair on `{ afterAction: run }`; `typescript-vite-preview` uses chains (unaffected) |

Probe scripts were run from the repo root and removed afterwards; no files were modified.

---

## Suggested order

1. **CORE-01** — reachable in production streaming playback, and one path throws.
2. **STUDIO-07** — silent inversion of a documented ordering guarantee, in every lesson.
3. **CORE-03 + CORE-02** — same cache-staleness family, plus the per-tick chat fold.
4. **STUDIO-08 + SKILL-04** — both directly degrade the agent-authoring loop.
5. **SKILL-03** — regenerate and check the full bundle including the zip.
6. **CORE-04** — small machine change, silent total failure when it hits.
7. The remaining Low items as cleanup: CORE-05…08, STUDIO-09…12.

---

## Recommended commit message

```
docs(review): record core, replay-machine, and studio lesson-pipeline review
```
