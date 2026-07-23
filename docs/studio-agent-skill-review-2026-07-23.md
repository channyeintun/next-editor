# Studio and lesson-script skill review

**Review date:** 2026-07-23

**Baseline:** `aa34416` (`main`)

**Scope:** Studio authoring, compilation, scheduling, performance, artifact QA,
repeatability, draft handoff, screen capture, and both lesson-script skill
surfaces (`.claude/skills/lesson-script/` and `share/lesson-script-skill/`).

## Verdict

The Playground lesson path is well factored, and the recent typed-frame/cursor
work has focused regression coverage. The current Studio should not yet be
treated as a fail-closed artifact pipeline, however: several gates inspect the
pre-encode object instead of the decoded `.ne`, the draft handoff can combine a
previous recording with the newly selected lesson's metadata, and WebContainer
dependency actions do not have coherent planned times.

The distributed lesson-script skill is also materially behind the implemented
schema. In particular, it advertises JavaScript and TypeScript while instructing
agents to author a runtime shape that the importer rejects.

## Findings

### STUDIO-01 — High — Artifact QA can pass data that is absent from the encoded `.ne`

`runArtifactChecks` decodes `neBytes` and creates `artifactRecording`, but then
continues to validate the original in-memory `recording` for duration, editor,
cursor, workspace and runtime timestamps, audio metadata, captions, and final
file checkpoints
([qa.ts](../src/studio/qa.ts#L193),
[qa.ts](../src/studio/qa.ts#L216),
[qa.ts](../src/studio/qa.ts#L284),
[qa.ts](../src/studio/qa.ts#L297),
[qa.ts](../src/studio/qa.ts#L479)). Only the preview envelope, required-track
set, encoded console, and output checkpoints consistently use the decoded
object.

This permits the following false pass:

1. The in-memory recording has the expected typed file, captions, and monotonic
   events.
2. An encoder/decoder regression drops or changes one of those fields.
3. `recording.decodes` still passes because it only requires version 4 and
   `streamFinalized`.
4. `checkpoint.file`, `captions.attached`, and the affected event checks inspect
   the good in-memory object and remain green.

The manifest's final workspace hash and repeatability semantics are also
derived from the in-memory recording, so neither catches the discrepancy
([runStudioRender.ts](../src/studio/runStudioRender.ts#L471),
[runStudioRender.ts](../src/studio/runStudioRender.ts#L483)).

**Impact:** Studio can expose a downloadable, passing bundle whose replay data
does not contain the state that passed QA. This defeats the primary reason for
round-tripping the artifact.

**Required resolution:** after decode succeeds, run every artifact gate,
semantic extraction, and final-workspace manifest calculation against the
decoded recording. Add inverse-mismatch tests: pass a good in-memory recording
with bytes encoded from a copy missing a file checkpoint, captions, and each
required event track; every case must fail.

### STUDIO-02 — High — Create draft can upload an old recording under the newly selected lesson

`latest` is global controller state initialized from module-level `runHistory`;
changing the lesson updates only the query parameter
([StudioController.tsx](../src/studio/StudioController.tsx#L191),
[StudioController.tsx](../src/studio/StudioController.tsx#L198),
[StudioController.tsx](../src/studio/StudioController.tsx#L332)). The displayed
`artifacts` continue to come from that old `latest`, while `source` comes from
the new `planSlug`
([StudioController.tsx](../src/studio/StudioController.tsx#L544)).

The draft modal consequently receives `artifacts.recording` from the previous
run but computes `initialTitle` from the currently selected source
([StudioController.tsx](../src/studio/StudioController.tsx#L578)). A concrete
sequence is:

1. Render lesson A successfully.
2. Select lesson B without rendering it.
3. Press **Create draft…**.
4. The modal uploads A's recording with B's title.

The stale artifact buttons also remain enabled during a subsequent render
([StudioController.tsx](../src/studio/StudioController.tsx#L782)), and a plan
build exception occurs before `setLatest`, leaving the previous passing
artifact available beside the new failure.

**Impact:** a reviewer can create a mislabeled draft or open the upload flow
during another recording. The description contains A's manifest slug, but that
does not prevent the wrong title/content pairing.

**Required resolution:** bind result metadata (title, source revision, voice
choice, and artifact) into one immutable run entry. Expose download/draft
actions only when that entry's slug and source revision match the selected
lesson and no render is running. Clear or hide stale results on selection,
render start, and pre-render failure. Cover A → select B and A → failing B in a
controller test.

### STUDIO-03 — High — `afterAction` does not produce a usable timeline for WebContainer actions

The source contract says `afterAction` means "after the referenced action
completes", but compilation assigns the dependent action the predecessor's
original planned timestamp
([schema.ts](../src/studio/script/schema.ts#L29),
[compile.ts](../src/studio/script/compile.ts#L200)). Sequential performance
makes the actual start happen later, but:

- dialog scheduling ignores every `afterAction` dependency
  ([schedule.ts](../src/studio/script/schedule.ts#L105));
- timing statistics include all successful non-`expect.*` lifecycle and preview
  actions ([report.ts](../src/studio/report.ts#L111)); and
- the canonical TypeScript preview fixture chains `runtime.start` →
  `runtime.waitForReady` → `preview.open` this way, while opting out of all
  checks ([typescript-vite-preview.yaml](../src/studio/script/__fixtures__/typescript-vite-preview.yaml#L99),
  [typescript-vite-preview.yaml](../src/studio/script/__fixtures__/typescript-vite-preview.yaml#L138)).

A direct compile probe using the regression test's deterministic dialog
durations planned all three lifecycle actions at `5300ms`. In a real run,
`preview.open` can only begin after dependency installation/server readiness,
so its measured drift is the entire startup duration. Later narration markers
can also pass while the Performer is still blocked on readiness.

**Impact:** a JS/TS lesson following the fixture and the skill's mandatory
`timing.p95Ms` rule can fail by construction, while a slow startup can let
narration and recording end before the authored preview interaction. The
checked-in qualification fixture avoids detecting this with `checks: []`.

**Required resolution:** make dependencies explicit in the compiled plan and
define timing relative to the predecessor's acknowledgement, or move
WebContainer preparation/readiness before the recording clock starts. Dialog
scheduling and the timing gate must share that dependency model. Add a fixture
test with a timing gate and delayed readiness; do not qualify preview support
with an ungated fixture.

### SKILL-01 — High — The distributed skill teaches a runtime schema the importer rejects

The shared skill advertises Rust, Go, Kotlin, Python, JavaScript, and TypeScript
and calls its bundled reference "the complete contract"
([SKILL.md](../share/lesson-script-skill/SKILL.md#L1),
[SKILL.md](../share/lesson-script-skill/SKILL.md#L13)). Its runtime matrix says
JavaScript and TypeScript require `kind: none`, and then says kind-none lessons
may omit `runtime` entirely
([lesson-script-authoring.md](../share/lesson-script-skill/references/lesson-script-authoring.md#L101)).

The implementation requires:

- `runtime` at the top level for every lesson
  ([schema.ts](../src/studio/script/schema.ts#L231));
- `runtime.kind: webcontainer` for JavaScript and TypeScript
  ([plan.ts](../src/studio/plan.ts#L417)); and
- the `runtime.start`, `runtime.waitForReady`, preview command, and
  `expect.preview` actions that are absent from the shared action catalog.

The shared reference is internally contradictory too: it says JS/TS use
`kind: none`, then immediately says they pin a WebContainer workspace; it says
Python runs the WebContainer WASI model, then says that execution path is not
driven by Studio. It also claims import verifies Google page IDs, whereas
import only performs schema/marker/critic work; deck resolution happens during
the render build
([StudioController.tsx](../src/studio/StudioController.tsx#L343),
[inPageDirector.ts](../src/studio/inPageDirector.ts#L140)).

**Impact:** an external agent following the advertised self-contained skill
cannot author a valid JS/TS lesson and receives late, avoidable failures for
Google deck references.

**Required resolution:** regenerate the distributable reference from the
canonical in-repo contract instead of maintaining a fork. Add a bundle
contract check that parses one example per advertised lesson type against
`parseLessonScript`, and verify that its runtime matrix and action names are
derived from the schema.

### STUDIO-04 — Medium — Repeatability history is selected by mode, not by lesson or plan

When a run completes, the controller chooses the most recent historical run
with the same runtime mode and only afterwards checks its plan hash
([StudioController.tsx](../src/studio/StudioController.tsx#L485)). Because that
different-plan result satisfies the left side of `??`, the per-slug
`sessionStorage` baseline is never consulted.

Sequence A → B → A in the same mode therefore compares the final A candidate to
B, reports "Script changed", and resets the baseline even though a matching A
baseline exists in both history and storage.

**Impact:** repeatability disappears during ordinary multi-lesson review and
requires an unnecessary fourth render. The reset message incorrectly suggests
the A script changed.

**Required resolution:** search history for matching mode **and** plan hash (or
slug plus hash), then fall back to the current slug's stored baseline. Add an
A → B → A regression test.

### STUDIO-05 — Medium — `runtime=fixture` is documented and emitted by the CLI but ignored by the route

The controller recognizes only the exact value `runtime=live`; every other
value, including `fixture`, becomes `null` and falls back to the plan default
([StudioController.tsx](../src/studio/StudioController.tsx#L191)). Both the
route documentation and `scripts/studio-render.ts` expose
`runtime=fixture|live`, and the render CLI defaults to fixture
([StudioRoute.tsx](../src/studio/StudioRoute.tsx#L13),
[studio-render.ts](../scripts/studio-render.ts#L27),
[studio-render.ts](../scripts/studio-render.ts#L124)).

**Impact:** a Playground lesson whose pinned default is `live` will contact the
real service and require authentication even when the caller or automation
explicitly requested fixture mode. The current checked-in Playground scripts
default to fixture, which masks the bug.

**Required resolution:** parse both allowed values explicitly and reject or
surface invalid values instead of silently using the plan default. Unit-test
the query parsing independently from the controller.

### SKILL-02 — Medium — The in-repo agent instructions point into a contradictory runbook

The in-repo skill correctly says scripts auto-register and the Director writes
only a critique sidecar
([SKILL.md](../.claude/skills/lesson-script/SKILL.md#L36)). The authoring
contract links the operational runbook, however, and that runbook still tells
agents that the Director emits a compiled plan, to edit
`src/studio/plans/index.ts`, and that it writes
`src/studio/plans/scripts/<slug>.json`
([studio-m0-runbook.md](./studio-m0-runbook.md#L42),
[studio-m0-runbook.md](./studio-m0-runbook.md#L74)). The actual CLI validates
and writes only `<slug>.critique.json`
([studio-director.ts](../scripts/studio-director.ts#L41),
[studio-director.ts](../scripts/studio-director.ts#L67)).

Two smaller skill rules are also stale:

- it mandates `timing.p95Ms: 300` for every lesson, while the canonical
  Google-deck lesson and authoring contract use `500`;
- it names `fixture.result.output` as the universal output field even though
  Rust uses `stdout`.

**Impact:** an agent can make an unnecessary registry edit, look for a file
that is never emitted, or apply the wrong gate/fixture field despite reading
the required references in full.

**Required resolution:** rewrite the runbook's authoring sections around the
current in-page compilation flow and mark the old M0 procedure as historical.
Make the skill language-aware for fixture output and repeat the documented
500ms Google-deck exception.

### STUDIO-06 — Medium — Screen recording promises narration but can produce a silent video

The Studio tooltip promises "narration included"
([StudioController.tsx](../src/studio/StudioController.tsx#L740)). The screen
recorder only mixes audio tracks returned by `getDisplayMedia` plus an optional
microphone track; with no such tracks it deliberately records video-only
([screenActor.ts](../src/core/src/machine/screenActor.ts#L65)). Studio uses
external narration, so it has no microphone track to supply, and it never feeds
the known narration blob into the screen mix.

Browsers that do not return display audio, a screen/window share rather than a
tab share, or a user who leaves "share tab audio" off therefore receive a
silent file with no warning.

**Impact:** the standalone review/share video can omit the lesson's defining
audio even though the UI and authoring contract say it is included.

**Required resolution:** mix the already available narration audio into the
screen capture graph directly, independent of display-audio support. At
minimum, detect the absence of an audio track before recording and change the
UI/result message to say the video is silent.

## Verification performed

All commands were run sequentially with one worker, per the repository's VPS
constraints.

| Check                                                                                                | Result                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/studio/qa.test.ts`                                                                              | 10 passed                                                                                                       |
| `src/studio/script/jsTsPreview.test.ts`                                                              | 3 passed                                                                                                        |
| `src/core/src/machine/editorMachine.test.ts` filtered to typed-content/workspace-snapshot regression | 1 passed, 37 skipped                                                                                            |
| `src/core/src/utils/cursorReplay.test.ts`                                                            | 7 passed                                                                                                        |
| Direct TypeScript preview compile probe                                                              | `runtime.start`, `runtime.waitForReady`, and `preview.open` all planned at `5300ms`; fixture has no timing gate |
| Canonical vs shared contract diff                                                                    | Shared bundle lacks the WebContainer runtime/action contract and contains the stale kind-none matrix            |

No full build, repository-wide typecheck/test, headless browser render, or live
runtime call was attempted on the low-resource Linux host. Those checks are
prohibited or inappropriate for a documentation-only review here.

## Recommended remediation order

1. Make QA and manifest/semantic extraction authoritative over the decoded
   artifact.
2. Scope artifacts and draft metadata to one selected, completed run.
3. Resolve WebContainer dependency timing and add a gated qualification
   fixture.
4. Regenerate and contract-test the distributed skill.
5. Fix route-mode parsing and per-plan repeatability lookup.
6. Align the in-repo runbook/skill and make screen-recording audio guarantees
   truthful.
