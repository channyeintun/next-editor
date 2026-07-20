# Agent Feature Review

Reviewed 2026-07-20 at `c83b256` (main). Scope: the in-browser coding agent for lesson authoring — `src/agent/**`, `src/components/agent/**`, `src/shared/openrouterProxy.ts`, `tube/vite/openrouterProxyPlugin.ts`, `infra/worker/routes/openrouter.ts`, plus the chat types in `src/types/chat.ts` and the workspace-store seams the tools use.

## Verdict

The feature is in very good shape for its stated purpose (simple, lightweight lesson-authoring tasks). The architecture is clean and deliberate, the security posture around the BYOK key is genuinely careful, and the test suite covers the parts that are actually hard (loop adaptation, bash reconciliation, credential storage). Nothing found is a blocker. The findings below are ranked; the top four are worth scheduling, the rest are polish.

## Architecture (as reviewed)

```
AgentPanel (UI, dock-mounted)
  └─ agentSession (module-scope run state: abort, confirmations, retry)
       └─ runAgentLoop (agentLoop.ts)
            ├─ @openrouter/agent callModel() — owns the tool loop, stepCountIs(30)
            │    └─ same-origin /api/openrouter/responses proxy → OpenRouter Responses API (beta)
            ├─ tools/* — execute against workspaceStore triggers (recording for free)
            └─ onDelta: ChatDelta stream → agentStore (live UI) + chatRecording (lesson track)
```

Key properties that hold up under review:

- **One delta stream, two consumers.** The loop adapts the SDK's `getItemsStream()` into `ChatDelta`s that feed both the live transcript and the recording track, and the replayed transcript is folded by the same `applyChatDelta` reducer the live store uses. This is the right invariant and it is tested.
- **Transcript is always API-valid.** `balanceUnansweredCalls()` closes any streamed `tool_call` that never got an output with a synthetic error result, so a stopped/failed turn never poisons the next run's history (the Responses API rejects unpaired calls).
- **Tools never bypass the store.** Writes go through `store.trigger.*`, so path normalization, dirty state, and the workspace recording track all apply. The bash tool's three-way fold (`foldContainerChangesIntoStore`) preserving concurrent editor edits is the most subtle code in the feature and has the best tests.
- **Per-lesson-type tool profiles.** Playground lessons (go/rust/kotlin) get file tools only, with stack-specific system prompts; WebContainer lessons add bash + runtime/preview observation. Tool lists, prompts, and gating agree with each other.
- **Recording stays light where it matters.** `capture_preview` screenshots reach the model in-turn but are recorded/persisted as an `[input_image]` placeholder, not bytes. (Pasted user images are the exception — see F4.)

## Security review

- **API key**: memory-first with explicit opt-in to session/local storage, honest UI labels for each level, `type="password"` + `ph-no-capture` on the input (PostHog replay-safe), and `formatAgentError` deliberately walks only known error fields so a serialized request/headers object can never leak the key into the UI or recording. This is a solid BYOK posture; the residual risk (page JS can read the key — inherent to running client-side) is documented in `credentials.ts` and acknowledged in plan §8.
- **Proxy**: fixed upstream URL (no user-controlled target → no SSRF), strips `cookie` and infra headers on the way out and CORS/hop-by-hop headers on the way back, streams SSE bodies through, never reads or logs the Authorization header. The dev middleware and Worker route share one implementation. Good.
  - The Worker endpoint is unauthenticated, so third parties could relay through it — but they must bring their own OpenRouter key, so there's no confused-deputy value in doing so; the only cost is your Worker bandwidth. Accepted risk; an `Origin`/`Sec-Fetch-Site` check would be a one-line hardening if it ever shows up in logs.
- **Prompt injection**: the system prompt explicitly marks dev-server output, preview text/DOM, and screenshots as untrusted data. Workspace `AGENTS.md`/`CLAUDE.md` are ingested as guidance by design — for self-authored lessons that's the right trust model, but note that an **imported** zip can carry a hostile `AGENTS.md`. The blast radius is bounded (bash is confirm-gated; write/edit are not, but the user is watching an editor they own), which seems proportionate.

## Findings

| #   | Severity | Where                                  | Summary                                                                                                        |
| --- | -------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| F1  | Medium   | agentLoop.ts:295–308                   | Token usage under-counts multi-step turns (only the last round is counted)                                     |
| F2  | Medium   | agentStore.ts / agentSession.ts        | Transcript and retry state survive workspace replacement; stale history leaks into the new lesson              |
| F3  | Medium   | tools/read.ts, tools/grep.ts           | No per-line/total-byte caps — one long-line file can flood the context window                                  |
| F4  | Medium   | imageAttachments.ts, chatRecording.ts  | Pasted images are never downscaled and are duplicated into every checkpoint                                    |
| F5  | Low–Med  | AgentPanel.tsx:288, 338–349            | `capture_preview` falsely errors for non-fallback models after a panel remount                                 |
| F6  | Low      | agentLoop.ts:186–191, 288–292          | Post-loop provider-error path lacks an `aborted` guard; Stop may surface a spurious error                      |
| F7  | Low      | AgentPanel.tsx:400–405                 | Enter-to-send ignores IME composition                                                                          |
| F8  | Low      | tools/write.ts → workspaceStore.ts:747 | Every agent-created file steals editor focus                                                                   |
| F9  | Low      | tools/grep.ts:25, tools/glob.ts:20     | Two `globToRegex` implementations with divergent `**` semantics                                                |
| F10 | Low      | tools/grep.ts:87, 121                  | `g`-flag `regex.test` fragility; model-supplied regex runs on the main thread                                  |
| F11 | Nit      | agentStore.ts:26                       | Model selection not persisted across reloads                                                                   |
| F12 | Nit      | credentials.ts:108                     | Comment says "Anthropic key"; it's an OpenRouter key                                                           |
| F13 | Process  | package.json:28                        | Beta SDK on a beta API with a caret range — consider exact-pinning                                             |
| F14 | Info     | agentLoop.ts:241–273                   | Reasoning items are dropped; long "thinking" stretches look stalled                                            |
| F15 | Info     | agentLoop.ts:109–122                   | SDK now ships native tool approval + state persistence; hand-rolled gate is fine but no longer the only option |

### F1 — Usage under-counts multi-step turns (Medium, confirmed)

`onUsage` reads `(await result.getResponse()).usage` ([agentLoop.ts:295–308](src/agent/agentLoop.ts#L295)). In `@openrouter/agent` 0.7.2, `getResponse()` returns `this.finalResponse`, which is only the **last** round's response object; per-round usage lives on each round (`round.response.usage` in the SDK's `model-result.js`), and nothing aggregates it. A turn that makes 8 tool-loop requests reports the input/output tokens of request 8 alone, so the "Usage this session" figure in settings can be off by an order of magnitude on tool-heavy turns.

Fix: accumulate usage in the full-stream observer you already run (`getFullResponsesStream()` — sum usage from each `response.completed` event), or walk the SDK's step history if exposed. Keep `getResponse()` only as a fallback.

### F2 — Conversation outlives the workspace it happened in (Medium)

`getAgentStore()` is an app singleton, deliberately (dock tabs unmount the panel mid-run — the comment in agentSession.ts explains this well). The side effect: the transcript also survives **workspace replacement**. The only `reset()` call site is the New-chat button ([AgentPanel.tsx:368](src/components/agent/AgentPanel.tsx#L368)). Concretely: import a different lesson zip (the store's project is replaced in place — bash's fold logic even has a comment for this case, [bash.ts:110–116](src/agent/tools/bash.ts#L110)) or navigate to another lesson, and the next prompt replays the previous lesson's entire history — old file paths, old file contents, old tool results — as model input for the new workspace. That misleads the model and silently spends tokens. `retryOptions` has the same issue one level worse: it pins the old `workspace` store instance ([agentSession.ts:199–208](src/agent/agentSession.ts#L199)), so a Retry after switching lessons can act on the wrong store.

Fix: remember the `project.id` a conversation belongs to (e.g. in `agentStore`) and reset transcript + retry state when a run (or the panel) sees a different id. If cross-lesson continuity is _intended_, it deserves a comment, because today it looks accidental.

### F3 — `read`/`grep` have no width bounds (Medium)

`read` caps at 2000 **lines** but never truncates a line ([read.ts:23–32](src/agent/tools/read.ts#L23)); `grep` caps at 200 matching lines but likewise returns each line whole. One minified or generated file (a copied `bundle.js`, an inlined SVG, a data-URI) can put hundreds of KB into a single tool result — burning context, money, and latency, and potentially blowing the model's input limit mid-turn. The bash tool already solves this class of problem properly with `BoundedCommandOutput` (head + tail + omission count); `read`/`grep` deserve the same discipline: a per-line cap (~2,000 chars with a `… line truncated` marker) plus a total-output cap.

### F4 — Pasted images: no downscaling, duplicated per checkpoint (Medium)

`createChatImage` accepts up to 4 × 5 MB images as-is ([imageAttachments.ts:3–4](src/agent/imageAttachments.ts#L3)). Two consequences:

1. **Per-turn cost**: history is rebuilt with `toResponsesInput` every turn, so every prior image's data URL is re-uploaded on every subsequent request in the conversation (~6.7 MB base64 per 5 MB image, through your proxy, every turn).
2. **Recording size**: the `message_start` delta records each image once (fine), but every `ChatCheckpoint` embeds the full `items` array — images included ([chatRecording.ts:30–37](src/agent/chatRecording.ts#L30), [chat.ts:80–85](src/types/chat.ts#L80)). Checkpoints fire at every run end, so a session with several runs after an image paste duplicates that image into each subsequent checkpoint. A handful of screenshots can add tens of MB to a `.ne` file that the dmp-delta design otherwise keeps tiny.

Fix: downscale on paste (canvas → max ~1568 px long edge, re-encode as WebP/JPEG ~0.85) — this alone typically turns 5 MB into <300 KB and improves model behavior (providers downscale anyway). Longer term, store chat images once (the recording already has an asset store for workspace binaries) and reference them by id from items/checkpoints.

### F5 — `capture_preview` falsely blocked after panel remount (Low–Medium)

The image-support gate throws unless `selectedModelOption?.supportsImages` ([AgentPanel.tsx:338–343](src/components/agent/AgentPanel.tsx#L338)). `modelOptions` starts as `FALLBACK_MODEL_OPTIONS` on every mount and the live catalog only loads when settings is opened ([AgentPanel.tsx:219, 245–279](src/components/agent/AgentPanel.tsx#L219)). So: pick any model that isn't in the 15-entry fallback list, switch dock tabs (panel remounts, `hasLoadedModelCatalogRef` is fresh), then ask for a screenshot — `selectedModelOption` is `undefined` and the tool reports "does not advertise image input support" for a perfectly capable model. Fail open instead: treat an _unknown_ model as image-capable and let the provider reject it, or persist the selected option (id + supportsImages) rather than just the id.

### F6 — Stop can surface a spurious provider error (Low, unconfirmed edge)

Two small gaps around abort:

- The observer's `catch` keeps its own error as `providerError` when nothing else was seen ([agentLoop.ts:186–191](src/agent/agentLoop.ts#L186)). If `result.cancel()` makes `getFullResponsesStream()` reject with an abort-shaped error, that error is retained.
- The post-loop path (`break` on `signal.aborted`) checks `if (providerError) throw` with **no** `signal.aborted` guard ([agentLoop.ts:288–292](src/agent/agentLoop.ts#L288)) — unlike the `catch` path, which returns cleanly when aborted (line 277).

Combined, a user Stop could end as "The agent hit an error" + Retry instead of a clean done. Whether it fires depends on the SDK's cancel semantics (it evidently doesn't in the common path, since Stop works today). The guard is one line: skip the post-loop `providerError` throw (and the observer-error retention) when `signal.aborted`.

### F7 — IME composition submits early (Low)

`handleKeyDown` sends on plain Enter ([AgentPanel.tsx:400–405](src/components/agent/AgentPanel.tsx#L400)). For CJK and other IME users, Enter is how a composition is confirmed; without an `event.nativeEvent.isComposing` (or `keyCode === 229`) guard, confirming a conversion submits a half-composed prompt. Standard one-line fix.

### F8 — Agent-created files steal editor focus (Low / design question)

`writeFile` → `createFile` sets `activeFilePath` to the new file ([workspaceStore.ts:747](src/stores/workspaceStore.ts#L747)). During a run that scaffolds several files, the user's editor tab jumps to each one while they may be reading something else (updates to existing files don't do this — `updateFileContent` leaves focus alone). If the jump is intended as "watch the agent work" narrative for recordings, a comment would help; if not, add a `createFile` variant/flag that doesn't switch focus and use it from the tool.

### F9 — Two divergent glob implementations (Low)

`grep.ts:25–58` and `glob.ts:20–54` each define `globToRegex` with different `**` semantics: grep maps any non-`**/`-prefixed `**` to `.*`, while glob only does so for a trailing `**` and degrades mid-pattern `**` to `[^/]*[^/]*` (no `/` crossing). So `a**b`-style patterns match differently between the `glob` argument of grep and the `glob` tool. Nobody sane writes those patterns, but the fix is free: one shared helper in `tools/` used by both.

### F10 — grep regex hygiene (Low)

- `regex.test(line)` with the `g` flag is stateful; the code compensates with `regex.lastIndex = 0` after each match ([grep.ts:121, 132](src/agent/tools/grep.ts#L121)) and non-matches self-reset, so it's _currently_ correct — but dropping the `g` flag removes the trap entirely (nothing uses `lastIndex`).
- The pattern is model-supplied and runs on the main thread over every text file. A catastrophic-backtracking pattern will freeze the tab for the duration. Lesson workspaces are small, so this is an accepted risk worth one comment; if workspaces grow, move matching into a worker or add a line-length cap (which F3 gives you anyway).

### F11 — Model choice resets on reload (Nit)

`agentStore.model` is in-memory only; every reload returns to `claude-haiku-4.5`. The key already has an opt-in persistence story; the model id is non-secret and could simply live in `localStorage`.

### F12 — Stale comment (Nit)

`credentials.ts:108`: "there is exactly one **Anthropic** key per browser" — leftover from the pre-OpenRouter era; update to avoid confusing the next reader about which key this is.

### F13 — Beta pinning (Process)

`@openrouter/agent` is beta and OpenRouter's own docs recommend pinning exact versions; the Responses API it drives is also documented as beta ("may have breaking changes"). `^0.7.2` allows any 0.7.x patch to land silently via lockfile refreshes. Given the recording format is coupled to the SDK's item shapes, consider an exact pin (`0.7.2`) and deliberate, tested bumps.

### F14 — Reasoning items are invisible (Info)

The item adapter handles `message`, `function_call`, and `function_call_output` and drops everything else ([agentLoop.ts:241–273](src/agent/agentLoop.ts#L241)). Reasoning-heavy models (GPT-5.x, Claude with thinking) stream `reasoning` items during which the panel shows "Streaming…" with zero visible progress, sometimes for tens of seconds. Consider a lightweight "thinking…" indicator when a reasoning item is active (no need to record the content — a status delta suffices).

### F15 — SDK-native approval now exists (Info)

Since this feature shipped, the SDK grew first-class `requireApproval` (tool-level and call-level), an `awaiting_approval` pause status with `getPendingToolCalls()` / `approveToolCalls` resumption, and a `StateAccessor` interface for persisting conversation state across reloads. The current hand-rolled gate (promise inside `execute`, [agentLoop.ts:109–122](src/agent/agentLoop.ts#L109)) is sound and has one real advantage — the stream stays open and ungated tools keep running in parallel — so there's no need to migrate. But if you ever want "confirmation survives a page reload" or multi-tool approval batching, the SDK path now exists and would delete code rather than add it. Details in [research.md](research.md).

## Test coverage assessment

Strong where it counts: the loop adapter (streaming, history replay, images, abort, unanswered-call balancing, provider-error preservation), bash reconciliation (deletes/renames/binaries/concurrent edits/timeout/bounded output), credentials (storage matrix), system prompts (per-stack constraints), error formatting. Gaps worth one test each if you touch the code anyway: F1 (usage accumulation across steps), F2 (reset on project change), F6 (abort with a pending provider error). UI-level behavior (AgentPanel) is untested, consistent with the project's "tsc + tests + user eyeballs UI" convention.

## Recommended order

1. F4 image downscaling (biggest cost/size lever, smallest patch)
2. F2 reset-on-workspace-change (correctness of what the model sees)
3. F3 read/grep bounds (context + cost protection)
4. F1 usage accumulation (make the number honest)
5. F5–F12 as batched polish
