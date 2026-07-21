# Studio JavaScript/TypeScript preview-interaction review

**Review date:** 2026-07-21

**Scope:** `LessonScript` authoring, compilation, performance, preview capture, QA, and
repeatability for `javascript` and `typescript` lessons in `src/studio/`.

## Verdict

Basic JavaScript and TypeScript lessons work when they only narrate, open files, add text, use
slides/whiteboards, and assert file content. They validate through the Director and compile into a
`StudioPlan` with `runtime.kind: none`.

Preview-interaction lessons are **not supported by the deterministic Studio pipeline yet**. A
script cannot start or await the WebContainer, open the preview, interact with its iframe, or
assert preview state. If a preview happens to start through the ordinary editor's auto-run behavior,
it is outside the plan and outside the Studio's semantic QA. Such a render can therefore pass while
the preview is absent, late, broken, or different between runs.

The recorder foundation is already useful: ordinary runtime previews inject rrweb plus interaction
capture, and the preview bridge records DOM changes, routes, scrolling, clicks, focus, and input.
The missing work is the typed Studio adapter and its fail-closed checks, not a new recording format.

## Findings

### STP-01 — High — No preview action can pass the authoring or performance pipeline

The authored action union has only workspace, editor, playground runtime, slide, whiteboard, and
file/output assertion actions. The compiled union and `StudioDriver` have the same boundary; none
has a preview command or preview expectation
([script/schema.ts](../src/studio/script/schema.ts#L43-L107),
[plan.ts](../src/studio/plan.ts#L66-L135),
[driver.ts](../src/studio/driver.ts#L57-L78)).

Both JS and TS are forced to `runtime.kind: none`, which the source explicitly describes as a
pending WebContainer/preview adapter. `runtime.run` is rejected at schema time and would fail in the
driver as well ([plan.ts](../src/studio/plan.ts#L276-L318),
[driver.ts](../src/studio/driver.ts#L282-L286)).

A probe adding `type: preview.open` failed with the expected discriminator error. The same applies
to possible `preview.click`, `preview.input`, `preview.scroll`, or `expect.preview` actions because
none is part of the closed union.

**Impact:** an agent cannot author the requested interaction. Import fails before synthesis or
render, so there is no supported unattended JS/TS preview lesson to test end to end.

**Required resolution:** add a versioned WebContainer runtime declaration and the smallest useful
closed action set, for example runtime start/wait, preview open, click, input, scroll, route, and DOM
expectation. Every command needs a receipt, timeout, cancellation, stable target, and explicit retry
policy. Runtime-iframe commands should use an acknowledged `postMessage` bridge because the preview
may be cross-origin.

### STP-02 — High — Ambient WebContainer auto-start is unpinned and races the recording clock

`/studio` mounts the ordinary `Editor`, including `WebContainerRuntimeProvider`
([StudioRoute.tsx](../src/studio/StudioRoute.tsx#L16-L17),
[Editor.tsx](../src/components/Editor.tsx#L331-L363)). Loading a JS/TS workspace can therefore trigger
the normal auto-start path. Its default configuration enables startup and file-save reruns and uses
`pnpm install` plus `pnpm dev` ([webContainerRuntimeSupport.ts](../src/contexts/webContainerRuntimeSupport.ts#L34-L40),
[WebContainerRuntimeProviderImpl.tsx](../src/contexts/WebContainerRuntimeProviderImpl.tsx#L531-L558)).

The Studio preflight waits only for the project and Monaco entry model before starting the external
audio recording. It does not wait for runtime readiness, a server-ready URL, preview iframe load, or
preview recorder readiness ([runStudioRender.ts](../src/studio/runStudioRender.ts#L178-L228)). The
preview panel also begins closed and has no Studio action to open it
([PreviewPanelContext.tsx](../src/contexts/PreviewPanelContext.tsx#L50-L75)).

The init/run commands and dependency installation state are not pinned in `LessonScript` or the
manifest. They can depend on browser support, cache state, package registry access, and mutable
runner settings.

**Impact:** incidental preview startup may land before, during, or after narration, and may remain
invisible. Two machines can perform the same compiled plan but observe different preview behavior.

**Required resolution:** disable ambient auto-start for Studio renders and let the plan own startup.
Pin the runner contract and applicable lockfile, wait on observable runtime/server/iframe readiness,
then open the preview at a planned time. Dependency and network failures must abort the render with
diagnostic receipts.

### STP-03 — High — Artifact QA and repeatability can pass without a correct preview

Artifact QA checks frame, cursor, workspace, and runtime timestamps, but not preview-event,
preview-initial-document, or preview-patch timestamps. Its required track list omits preview, and its
only semantic checkpoints are console output and final file content
([qa.ts](../src/studio/qa.ts#L106-L143), [qa.ts](../src/studio/qa.ts#L187-L221)).

Repeatability similarly compares action receipts, workspace, captions, audio, console, action
timing, and duration. It does not include preview DOM, route, interaction sequence, screenshots, or
preview errors ([compare.ts](../src/studio/compare.ts#L14-L57)).

**Impact:** a blank iframe, failed dev server, missing click, wrong post-click state, or divergent
preview can still receive a passing report and a passing two-render comparison.

**Required resolution:** require preview records for plans that declare preview use; validate their
timestamps and bounds; fail on preview console errors/exceptions; evaluate authored DOM/route
assertions; and include normalized preview state plus the authored interaction sequence in
repeatability semantics. Diagnostic screenshots should accompany failed preview checkpoints.

### STP-04 — Medium — Completion claims and the authoring contract disagree with the code

The architecture plan says M0-M4 are implemented, while M2 explicitly includes preview adapters and
readiness signals ([agent-lesson-production.md](./agent-lesson-production.md#L3-L10),
[agent-lesson-production.md](./agent-lesson-production.md#L387-L391)). The implementation and the
more detailed authoring contract correctly say the WebContainer path is pending
([plan.ts](../src/studio/plan.ts#L276-L282),
[lesson-script-authoring.md](./lesson-script-authoring.md#L130-L139)).

The authoring contract also says a `kind: none` lesson may omit `runtime:`, but the schema requires
the property ([lesson-script-authoring.md](./lesson-script-authoring.md#L136-L139),
[script/schema.ts](../src/studio/script/schema.ts#L151-L169)). A probe without `runtime` failed with
`runtime: Invalid input: expected object, received undefined`.

**Impact:** an agent can reasonably infer that preview lessons are supported or emit YAML that the
document says is valid but the importer rejects.

**Required resolution:** mark M2 preview/WebContainer support as pending and make the contract match
the schema. Until the adapter exists, state plainly that JS/TS lessons are edit-only in Studio and
must include `runtime: { kind: none }`.

### STP-05 — Medium — Studio regression coverage has no JS/TS or `runtime.kind: none` fixture

The checked-in Studio tests and YAML fixtures exercise Go/Rust/Kotlin-shaped playground paths,
slides, whiteboards, compilation, performance, and QA. A repository search found no Studio test or
fixture whose `lessonType` is `javascript` or `typescript`, no `runtime.kind: none` case, and no
preview action case.

The separate preview tests prove that the generic editor can capture iframe interactions and round
trip rrweb DOM events, but they do not connect those primitives to a Studio action or gate.

**Impact:** basic JS/TS compilation can regress unnoticed, and future preview wiring could appear
complete without proving the full script-to-artifact path.

**Required resolution:** add one minimal JavaScript fixture and one TypeScript/Vite interaction
fixture. Keep schema/compiler/driver tests narrow, then require two real-browser renders for the
interaction fixture before declaring the adapter complete.

## Existing foundation that can be reused

- The runtime injects iframe interaction capture and rrweb recording into preview responses
  ([webContainerRuntimeSupport.ts](../src/contexts/webContainerRuntimeSupport.ts#L190-L221)).
- The preview bridge already turns routes, scrolls, clicks, focus, keyboard, and input into recording
  events ([usePreviewMessageBridge.ts](../src/components/preview/usePreviewMessageBridge.ts#L292-L370)).
- `WebContainerRuntimeContext` already exposes start/rerun actions plus readiness, URL, port, output,
  and preview-error metadata
  ([WebContainerRuntimeContext.ts](../src/contexts/WebContainerRuntimeContext.ts)).
- `PreviewPanelContext` already exposes semantic open/close operations
  ([PreviewPanelContext.tsx](../src/contexts/PreviewPanelContext.tsx#L70-L82)).

The Studio should wrap these surfaces behind its narrow driver rather than duplicate the preview or
recording implementation.

## Verification performed

| Check                                                                                                             | Result                                                       |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Director preflight of temporary JS and TS YAML scripts using `runtime: { kind: none }`, file open, and block edit | PASS for both scripts                                        |
| Direct schema probe for basic `javascript` and `typescript` scripts                                               | PASS                                                         |
| Direct compile probe through extraction, dialog scheduling, and `compileLessonScript`                             | PASS for both; compiled actions were cursor/open/cursor/type |
| Schema probe with `preview.open`                                                                                  | Rejected as unsupported, as expected                         |
| Schema probe with omitted `runtime`                                                                               | Rejected, exposing the documentation mismatch                |
| `src/studio/script/compile.test.ts`                                                                               | 14 passed                                                    |
| `src/studio/plan.test.ts`                                                                                         | 7 passed                                                     |
| `src/studio/performer.test.ts`                                                                                    | 3 passed                                                     |
| `src/studio/qa.test.ts`                                                                                           | 7 passed                                                     |
| `src/utils/iframeInteractionCapture.test.ts`                                                                      | 4 passed                                                     |
| `src/contexts/webContainerRuntimeSupport.test.ts`                                                                 | 11 passed                                                    |
| `src/components/preview/rrwebRoundTrip.test.ts`                                                                   | 2 passed                                                     |

All test files were run individually with one worker. Locked dependencies were installed before the
Vite+ checks; `package.json` and `bun.lock` did not change.

No browser render was attempted on the low-resource Linux host: repository guidance forbids browser
automation there, and the desired preview action is rejected before a render could begin. A manual
Chrome render is not a remaining validation step for the current code; the Studio adapter and QA
surface must exist first.

## Acceptance gate for preview-interaction support

Do not mark JS/TS preview lessons supported until one checked-in fixture proves all of the following:

1. The script pins a JS/TS workspace and runtime contract, starts it, waits for server and iframe
   readiness, and opens the preview through typed actions.
2. The Performer clicks or enters text through a stable preview target, receives an acknowledgement,
   and observes a resulting DOM or route change.
3. An authored preview assertion fails closed when the target is missing, the server errors, or the
   resulting DOM is wrong.
4. The encoded lesson contains preview seed/patch/interaction data that replays without rerunning the
   WebContainer.
5. Two clean Chrome renders pass normalized preview repeatability along with the existing gates.
6. A human watches the full replay before draft publication, consistent with the existing release
   policy.
