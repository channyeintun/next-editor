# Coding Agent Plan

A minimal, `pi`-inspired coding agent embedded in **next-editor**, used to author coding
lessons. It runs **in the browser**, talks to Anthropic with the **user's own API key**, and operates on
the editor's **current file system** (the workspace store) — not the OS file system.

> Status: design only. Nothing here is implemented yet. This document is the plan to review.

---

## 1. Goal

Give a lesson author an in-app "coding agent" they can drive from a CLI-style prompt: it
reads/writes/searches the files in the current workspace and (optionally) runs shell commands
in the WebContainer, streaming its work as it goes. Because it mutates the same workspace the
editor already records, an agent-driven session can become lesson content.

We model the _core foundations_ on [`earendil-works/pi`](https://github.com/earendil-works/pi)
(agent loop + a small tool set) but build our own tiny, self-contained version rather than
depending on pi's packages — pi is Node-only and multi-provider; we need browser-only and
Anthropic-only.

## 2. Constraints & non-goals

**Hard constraints (from the request):**

- **Browser runtime.** No Node.js — no `fs`, `child_process`, `path`, no `#!/usr/bin/env node`
  CLI. All file access goes through the workspace store; all shell goes through WebContainer.
- **Use the SDK.** The official `@anthropic-ai/sdk` (it is isomorphic — the _same_ package runs
  in the browser; there is no separate "node SDK"). Instantiate it in browser mode
  (`dangerouslyAllowBrowser: true`). Do **not** hand-roll `fetch` against the REST API.
- **User-supplied API key, no server-side key.** The agent authenticates with the user's own
  Anthropic **API key** (`sk-ant-api…`) — the only auth method usable from a browser (see §5.1).
- **Integrate with the current file system.** Tools bind to `workspaceStore`
  (`src/stores/workspaceStore.ts`), the app's existing source of truth for files.

**Non-goals (explicitly out of scope):**

- ❌ Subagents / orchestration (pi's `orchestrator` package).
- ❌ MCP.
- ❌ A TUI framework (pi's `tui` package). Our "CLI" is an in-app panel.
- ❌ Multi-provider abstraction (pi's `ai` package). Anthropic only.
- ❌ OAuth. Anthropic has no browser OAuth login flow, and a paste-a-bearer-token field isn't real
  OAuth — the agent uses an API key only (see §5.1).
- ❌ Publishing an npm package. This is app code under `src/`.

## 3. What we learned from `pi` (distilled)

pi is a Node/TypeScript monorepo of 5 packages. Only three inform us; we drop the other two:

| pi package     | Role                                                         | For us                                  |
| -------------- | ------------------------------------------------------------ | --------------------------------------- |
| `agent`        | Stateful agent loop + tool registry + event stream           | **Model our loop on this** (simplified) |
| `coding-agent` | The CLI + the actual coding tools + system prompt            | **Model our tools + prompt on this**    |
| `ai`           | Unified client over 30+ providers, wraps `@anthropic-ai/sdk` | **Skip** — use the SDK directly         |
| `tui`          | Terminal UI with differential rendering                      | Skip                                    |
| `orchestrator` | Subagents                                                    | Skip                                    |

**pi's agent loop** (from `packages/agent/src/agent-loop.ts`): stream an assistant message →
filter its content for `toolCall` blocks → execute them (parallel by default, sequential if any
tool opts in) → append `toolResult` messages → re-check stop conditions → repeat until there are
no tool calls left. Tools are `{ name, description, parameters (TypeBox schema), execute() }`
returning `{ content, details, terminate? }`. It emits events (`message_start/update/end`,
`tool_execution_start/end`, `turn_end`, …) for the UI to render.

**pi's tools** (from `packages/coding-agent/src/core/tools/` — 7 LLM-facing tools):

| Tool    | Params                                                                       | Notes                                                                                                           |
| ------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `read`  | `path`, `offset?`, `limit?`                                                  | Text + images; line/byte truncation                                                                             |
| `write` | `path`, `content`                                                            | Creates parents, overwrites                                                                                     |
| `edit`  | `path`, `edits: {oldText,newText}[]`                                         | Exact, unique, non-overlapping matches — **batched multi-edit in one call**; there is no separate `apply_patch` |
| `ls`    | `path?`, `limit?`                                                            | Sorted; `/` suffix on dirs                                                                                      |
| `find`  | `pattern` (glob), `path?`, `limit?`                                          | pi shells out to `fd`; respects `.gitignore`                                                                    |
| `grep`  | `pattern`, `path?`, `glob?`, `ignoreCase?`, `literal?`, `context?`, `limit?` | pi shells out to `rg`                                                                                           |
| `bash`  | `command`, `timeout?`                                                        | Spawns a shell in cwd; truncates output, spills full log to temp file                                           |

Registries: `createCodingTools()` = read/bash/edit/write; `createReadOnlyTools()` =
read/grep/find/ls; `createAllTools()` = all 7. There is **no per-tool approval gate** in pi —
only a one-time "trust this project directory" prompt at startup.

**pi's system prompt** (`system-prompt.ts`): dynamically assembled — a static core paragraph
("You are an expert coding assistant…") + the enabled-tools list + conditional guideline blocks

- optional project context files + current date + cwd.

**pi's Anthropic transport** (`packages/ai/src/api/anthropic-messages.ts`) — the useful part,
because it already does what we need for the browser:

- Wraps the official `@anthropic-ai/sdk` client (not raw fetch).
- Sets `anthropic-dangerous-direct-browser-access: true` so the SDK can call the API from a page.
- Passes the credential as `apiKey` (`x-api-key`).
- Maps `toolCall → {type:"tool_use", id, name, input}`, `toolResult → {type:"tool_result",
tool_use_id, content, is_error}`, tools → `{name, description, input_schema:{type:"object",
properties, required}}`, and streams SSE (`content_block_delta` with `input_json_delta`
  accumulated into tool-call JSON).

This confirms the browser + BYO-key approach is viable via the official SDK.

## 4. How this project stores files today (the integration target)

The **current file system is the workspace store**: `createWorkspaceStore()` in
[`src/stores/workspaceStore.ts`](src/stores/workspaceStore.ts), an `@xstate/store-react` store.
Its authoritative state is a `WorkspaceProject`
([`src/types/workspace.ts`](src/types/workspace.ts)):

```ts
interface WorkspaceProject {
  id: string;
  name: string;
  lessonType: WorkspaceLessonType; // "react" | "html-css" | "express-ts" | …
  entryFilePath: string;
  folders: string[]; // normalized folder paths
  files: Record<string, WorkspaceFile>; // keyed by normalized path
}
interface WorkspaceFile {
  path: string;
  name: string;
  language: string;
  content: string; // text, or base64 for binary
  encoding?: "utf-8" | "base64";
}
```

**Reads:** `store.getSnapshot().context.project` → `.files` (a `Record<path, WorkspaceFile>`) and
`.folders`. Paths are normalized with `normalizeWorkspacePath()` (no leading slash, forward
slashes). Binary assets are base64 (`isBinaryWorkspacePath()`, `base64ToBytes()`).

**Writes:** the store's events are exactly the mutations an agent needs (all via
`store.trigger.<event>(payload)` / `store.send`):

| Store event                                      | Payload                                               | Use for                                                       |
| ------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------- |
| `createFile`                                     | `{ path, content, encoding? }`                        | new file (no-op if exists; auto-creates folders; sets active) |
| `updateFileContent`                              | `{ path, content }`                                   | overwrite existing (no-op if unchanged)                       |
| `renameFile`                                     | `{ currentPath, nextPath }`                           | move/rename                                                   |
| `deleteFile`                                     | `{ path }`                                            | delete                                                        |
| `createFolder` / `renameFolder` / `deleteFolder` | `{ path }` / `{ currentPath, nextPath }` / `{ path }` | folders                                                       |
| `setActiveFilePath`                              | `{ path }`                                            | focus a file in the editor                                    |

Every mutation bumps `previewVersion` + `syncVersion`, which the app already watches to
re-render the preview and re-sync the runtime.

**Runtime / shell:** the WebContainer is a **downstream sync target**, not the source of truth.
[`src/contexts/webContainerRuntimeSupport.ts`](src/contexts/webContainerRuntimeSupport.ts) and
[`useWebContainerWorkspaceSync.ts`](src/contexts/useWebContainerWorkspaceSync.ts) already:

- `getOrBootSharedWebContainer()` → a singleton `WebContainer` (desktop only; gated by
  `isWebContainerRuntimeSupported()` — requires `crossOriginIsolated` and non-mobile).
- `syncWorkspaceProject(instance, prev, next)` pushes store → container FS; `readWorkspaceProject()`
  imports container FS → store (for files a command created).
- `instance.spawn(cmd, args)` runs processes; `instance.fs.{readFile,writeFile,readdir,mkdir,rm}`.

So a `bash` tool routes to `getOrBootSharedWebContainer()` + `instance.spawn('sh', ['-c', cmd])`,
and after the command finishes we can `readWorkspaceProject()` to fold any new files back into the
store.

**Conventions to match:**

- App-level state uses `createStore` from `@xstate/store-react` (see
  [`src/stores/apiClientStore.ts`](src/stores/apiClientStore.ts) — our template).
- Persisted keys are `next-editor-*` in `localStorage`.
- **No existing LLM/Anthropic code** — `@anthropic-ai/sdk` is a new dependency.

## 5. Recommended architecture

### 5.1 Runtime, SDK & auth

`@anthropic-ai/sdk`, constructed with the user's API key in **browser mode**:

```ts
new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
```

**API key only.** Anthropic documents just two auth methods — API keys and Workload Identity
Federation — and WIF is server/IdP-only (it exchanges a cloud IdP JWT that a browser SPA doesn't
have). There is no browser OAuth login flow, so the agent uses the user's `sk-ant-api…` key. The
SDK sends `anthropic-dangerous-direct-browser-access: true` in browser mode (set it explicitly
too); direct-browser CORS is documented for this API-key path.

### 5.2 The agent loop (manual streaming loop — recommended)

Use the **manual tool-use loop** with `client.messages.stream()`, not the beta Tool Runner. It
matches pi, keeps full control over rendering, avoids a beta dependency, and is the most legible
version for turning into a lesson. Sketch:

```ts
// messages: Anthropic.MessageParam[]
while (true) {
  const stream = client.messages.stream({
    model, // default "claude-haiku-4-5"
    max_tokens: 32000, // Haiku 4.5 output cap is 64K; stream regardless
    system: buildSystemPrompt(workspace),
    tools: TOOL_SCHEMAS, // JSON-schema tool defs
    messages, // no `thinking`/`effort` on Haiku — see note
  });
  stream.on("text", renderDelta); // stream assistant text into the CLI
  const msg = await stream.finalMessage();
  messages.push({ role: "assistant", content: msg.content });

  if (msg.stop_reason !== "tool_use") break;

  const toolUses = msg.content.filter((b) => b.type === "tool_use");
  const results = await Promise.all(toolUses.map(runTool)); // parallel; see note
  messages.push({ role: "user", content: results }); // ALL results in ONE user message
}
```

Notes grounded in the API reference:

- Append the **full `response.content`** each turn (preserves `tool_use`/thinking blocks).
- Return **all** `tool_result` blocks in a **single** user message; a failed tool returns
  `{ type:"tool_result", tool_use_id, content, is_error:true }` — never drop it.
- Parse `tool_use.input` as a parsed object (the SDK gives it to you parsed) — never string-match.
- Cap the loop (e.g. `maxIterations`) to avoid runaway cost.
- Wrap the whole thing in an `AbortController` so the CLI can cancel.
- **Thinking/effort are model-dependent.** Haiku 4.5 (our default) supports **neither** adaptive
  thinking nor `output_config.effort` (sending `effort` errors) — omit both (optionally
  `thinking:{type:"enabled", budget_tokens:N}`, `N < max_tokens`, if you want thinking). Add
  `thinking:{type:"adaptive"}` + `effort` **only** when the user switches to Sonnet/Opus.

Expose progress via a small event surface (callbacks or the agent store) so the CLI can show
"running `edit` on src/App.tsx…", streamed text, and errors.

### 5.3 Tools (bound to the workspace store)

Start with pi's set, minus the external-binary dependencies (`fd`/`rg`) which don't exist in the
browser — reimplement `find`/`grep` in-memory over `project.files`. Each tool is
`{ name, description, input_schema, execute(input) → {content, is_error?} }`.

| Tool                              | Backed by                           | Behavior                                                                                                                                                                                                               |
| --------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`                            | `project.files[path]`               | Text with `offset`/`limit` + truncation; base64 image → image content block; other binary → note.                                                                                                                      |
| `write`                           | `updateFileContent` or `createFile` | Exists → update; else create. Report bytes written.                                                                                                                                                                    |
| `edit`                            | read + `updateFileContent`          | Apply `{oldText,newText}[]`, each a **unique** match on LF-normalized content; return a unified-diff summary.                                                                                                          |
| `ls`                              | `files` keys + `folders`            | Immediate children of a normalized folder; `/` suffix on dirs; sorted.                                                                                                                                                 |
| `glob` (pi's `find`)              | `Object.keys(files)`                | In-memory match via `minimatch` (new small dep) or a tiny matcher.                                                                                                                                                     |
| `grep`                            | iterate `files`                     | Skip base64; regex per line; `file:line` + optional context; `limit`.                                                                                                                                                  |
| `bash` _(optional, desktop-only)_ | WebContainer                        | `isWebContainerRuntimeSupported()` gate → `spawn('sh',['-c',cmd])`; stream + truncate output; then `readWorkspaceProject()` to import new files. Returns a clear "runtime unavailable" error on mobile / non-isolated. |

Ship two registries mirroring pi: **read-only** (`read`, `ls`, `glob`, `grep`) and **coding**
(adds `write`, `edit`, `bash`). Default to coding; expose read-only as a safer mode.

Tool schema shape (JSON Schema, per the API reference):

```jsonc
{
  "name": "edit",
  "description": "Edit a file by exact text replacement. Each edits[].oldText must match a unique region.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Workspace-relative file path" },
      "edits": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": { "oldText": { "type": "string" }, "newText": { "type": "string" } },
          "required": ["oldText", "newText"],
          "additionalProperties": false,
        },
      },
    },
    "required": ["path", "edits"],
    "additionalProperties": false,
  },
}
```

(`strict: true` on the tool definition is available if we want guaranteed-valid inputs.)

### 5.4 System prompt

`buildSystemPrompt(workspace)` — a static core + dynamic context assembled from the store:
lesson type, entry file, a compact file tree (from `project.files`/`folders`), the enabled-tool
list, path conventions (workspace-relative, no leading slash), and a note that `bash` runs in a
sandboxed WebContainer when available. Keep it stable across turns for prompt-cache hits (put
volatile bits last).

### 5.5 The CLI surface

"CLI" here is an in-app command REPL, two options:

1. **xterm-based CLI (recommended, on-brand).** The app already ships `@xterm/xterm` and
   [`XtermTerminal.tsx`](src/components/XtermTerminal.tsx)/[`TerminalPanel.tsx`](src/components/TerminalPanel.tsx).
   Render the agent transcript + prompt in a dedicated xterm instance (separate from the
   WebContainer shell). Feels like a real coding-agent CLI.
2. **Plain React transcript + input (simpler).** A styled log of turns with a text input; least
   code, easiest to style, but less "CLI".

Both support: one-shot prompt (type task → run to completion) and an interactive back-and-forth.
No per-tool approval gate by default (matches pi); an optional confirm for `bash`/`deleteFile`
is a toggle (see Open decisions).

## 6. Where it lives / file layout

App code under `src/agent/` (it's browser code tightly coupled to `src/stores`, not a package):

```
src/agent/
  agentLoop.ts          # the streaming tool-use loop + AbortController
  anthropicClient.ts    # createAnthropicClient(apiKey) — browser-mode Anthropic client
  systemPrompt.ts       # buildSystemPrompt(workspace)
  tools/
    index.ts            # registries: read-only vs coding; name→tool map
    read.ts write.ts edit.ts ls.ts glob.ts grep.ts bash.ts
    workspaceFs.ts      # thin helpers over workspaceStore (read/list/mutate)
    editDiff.ts         # unique-match apply + unified diff (port of pi's edit-diff)
  agentStore.ts         # @xstate/store-react: messages, status, streamed text, error
  chatRecording.ts      # agent chat → insert/remove deltas + checkpoints (only while recording)
  credentials.ts        # in-memory cred + optional persistence (see Security)
  types.ts
src/components/agent/
  AgentPanel.tsx        # CLI surface (live) + read-only replay mode
```

Wire `AgentPanel` into the existing editor chrome next to the terminal/preview. It reads the
active `WorkspaceStoreInstance` from `WorkspaceStoreContext` and the WebContainer from the
existing runtime context.

The chat **recording/playback** track is cross-cutting and lives with the other tracks, not under
`src/agent/`: `ChatRecordingEvent` in [`src/types/chat.ts`](src/types/chat.ts); `chatEvents` +
`appendChatDelta` in [`recordingSession.ts`](src/core/src/machine/recordingSession.ts) and
`DeltaRecording` ([`deltaTypes.ts`](src/core/src/utils/deltaTypes.ts)); a `SEGMENT_KIND.chat` case
in the [`streamingRecordingCodec`](src/storage/streamingRecordingCodec); and
`replayState/chat.ts`. `chatRecording.ts` is just the thin seam that turns agent-store deltas into
`appendChatDelta` calls (§9.2).

## 7. Model & cost

Default to **`claude-haiku-4-5`** (Haiku 4.5) — fastest and cheapest, which matters because the
user pays per call; let them switch **up** to Sonnet/Opus in settings for harder tasks.

| Model     | ID                 | Input $/MTok  | Output $/MTok   | Note                                                                                         |
| --------- | ------------------ | ------------- | --------------- | -------------------------------------------------------------------------------------------- |
| Haiku 4.5 | `claude-haiku-4-5` | $1            | $5              | **Default**; fastest/cheapest; 200K context, 64K output; **no** adaptive thinking / `effort` |
| Sonnet 5  | `claude-sonnet-5`  | $3 ($2 intro) | $15 ($10 intro) | Upgrade; adaptive thinking + `effort`                                                        |
| Opus 4.8  | `claude-opus-4-8`  | $5            | $25             | Best coding/agentic; adaptive thinking + `effort`                                            |

On the Haiku default, **omit `thinking` and `output_config.effort`** — Haiku 4.5 supports
neither. Enable `thinking:{type:"adaptive"}` (+ optional `effort` `"high"`/`"xhigh"`) only when
the user selects Sonnet/Opus. Note Haiku's smaller **200K context** and **64K output** vs. the
1M/128K of the larger models — relevant for big workspaces or long turns. Stream (we do) so large
`max_tokens` doesn't hit HTTP timeouts. Since the user pays with their own key, surface `usage`
(input/output/cache tokens) per turn in the CLI.

## 8. Security considerations

- **BYO key is exposed to page JS.** Any XSS or malicious dependency in the app can read a key
  held in the page. Mitigations: keep the credential **in memory by default**; offer
  `sessionStorage` opt-in; only use `localStorage` (`next-editor-agent-credentials`) behind an
  explicit "remember on this device" checkbox with a clear warning. Never log it.
- **CORS / direct browser access.** Direct browser→Anthropic calls need
  `anthropic-dangerous-direct-browser-access: true` (SDK browser mode). If we ever want to hide
  the key or add refresh, the repo's Cloudflare Worker (`infra/worker`) could proxy — but that
  reintroduces a server and is explicitly _not_ what was asked, so keep it as a future option.
- **Mint a scoped, expiring key.** Recommend users create a dedicated API key with a short
  Console-set expiration (3h / 1d / 7d / 30d presets) and, if they use workspaces, scope it — so a
  key exposed in the browser has a bounded blast radius. Never log it; make revoke/rotate easy.
- **Untrusted content = tool output.** File contents and command output are untrusted; treat
  them as data, not instructions. `bash` runs in the **sandboxed WebContainer** (no host access),
  which bounds its blast radius. An optional approval gate for `bash`/`deleteFile` is available if
  we want a human in the loop.

## 9. Recording & playback

Two things change during an agent session and **both** must be captured and replayable: the
**workspace** (files) and the **chat conversation** (prompts, streamed assistant text, tool
calls/results). The workspace half already flows through the existing recorder; the chat half is a
**new track** we add to the same multi-track recording.

### 9.1 Workspace changes — already recorded (one caveat)

Because the agent mutates the same `workspaceStore` the editor records (`WorkspaceRecordingEvent` →
`DeltaRecording.workspaceEvents`), agent file operations already land in the recording and replay
through [`replayState/workspace.ts`](src/core/src/machine/replayState/workspace.ts). **Caveat:**
the fine-grained _content-delta_ track (the dmp codec) is driven by Monaco's own edit events, so a
store write to a **non-active** file yields a workspace snapshot diff but **no** keystroke-level
content delta. Agent edits therefore replay as file-state jumps, not typed-out text, unless we feed
them into the content-delta stream — a **follow-up** (§11.6) the minimal agent doesn't require.

### 9.2 Chat conversation — a new recording track

The recording format is already multi-track: `DeltaRecording` (v4,
[`deltaTypes.ts`](src/core/src/utils/deltaTypes.ts)) carries parallel `workspaceEvents`,
`runtimeEvents`, `cursorEvents`, … each a `{ timestamp, snapshot }[]` on one shared, audio-anchored
clock. The editor's own main track is already stored as **deltas**, not snapshots: `frames` is a stream of
`FrameDelta`s punctuated by a full `Keyframe` every `KEYFRAME_INTERVAL` for seeking
([`deltaTypes.ts`](src/core/src/utils/deltaTypes.ts)). The chat track follows **that** model — a
stream of insert/remove deltas with sparse seek checkpoints. (The runtime/workspace tracks store a full snapshot
per event; we deliberately do **not** copy that here.)

**Model — delta events + sparse checkpoints (never a per-event transcript snapshot).**

```ts
type ChatStatus = "idle" | "streaming" | "running-tool" | "done" | "error";

// Every delta records ONLY what changed: a node inserted/removed, or text
// inserted/removed inside the active message. No full-state records here.
type ChatDelta =
  | { k: "message_start"; id: string; role: "assistant" } // insert an empty message node
  | { k: "content"; delta: ContentDelta } // dmp insert/remove on the active message's text
  | { k: "tool_use"; id: string; name: string; input: unknown; path?: string } // insert a tool-call node
  | { k: "tool_result"; toolUseId: string; content: string; isError?: boolean } // insert a tool-result node
  | { k: "remove"; fromId: string } // drop nodes from `fromId` onward (aborted / retried turn)
  | { k: "message_end"; id: string; usage?: { input: number; output: number } }
  | { k: "status"; status: ChatStatus };

// ContentDelta is the SAME dmp primitive the editor content track uses
// (deltaTypes.ts, via getDmpCodec) — it encodes inserts AND removes, not just appends.

// Seek keyframe ONLY (frames-style), emitted sparsely — never the recording unit.
// The insert/remove delta log above is authoritative and fully reconstructs the transcript.
interface ChatCheckpoint {
  messages: ChatMessage[];
  status: ChatStatus;
}

interface ChatRecordingEvent {
  timestamp: number;
  event: ChatDelta | { k: "checkpoint"; state: ChatCheckpoint };
}
```

Content changes reuse the project's existing delta primitive — the dmp `ContentDelta` (Myers diff,
`getDmpCodec()`) that already powers the editor content track — so each `content` delta carries
exactly the chars **inserted or removed** in the active message, nothing more. Streaming is usually
a pure append (an insert), but an aborted, edited, or retried turn diffs to a **removal** for free;
`remove` drops whole nodes when a turn is truncated.

Replay is a **reducer**: rebuild the transcript by applying the insert/remove deltas in order. The
**delta log alone is authoritative and sufficient** — the `checkpoint` is only the frames-style
_seek keyframe_ so scrubbing to _T_ needn't replay from zero (restore nearest checkpoint ≤ _T_, then
apply deltas forward, exactly how the `frames` track seeks). A half-streamed message renders
mid-word, just as recorded. Because a chat keyframe is a full transcript (unlike the **bounded**
editor keyframe), keep it **sparse** (§11.5); it is never the recording unit.

**Touch-points** — plumbing mirrors the other event tracks; delta/replay mechanics mirror the
`frames` keyframe+delta track:

| Layer     | Template                                              | Add (chat)                                                             |
| --------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Type      | `RuntimeRecordingEvent` (`types/runtime.ts`)          | `ChatRecordingEvent` — `{ timestamp, event }` (`types/chat.ts`)        |
| Container | `DeltaRecording.runtimeEvents`                        | `DeltaRecording.chatEvents`                                            |
| Capture   | `appendRuntimeRecordingEvent` (`recordingSession.ts`) | `appendChatDelta` — push a delta; emit a `checkpoint` on a cadence     |
| Codec     | `SEGMENT_KIND.runtime = 6` + encode/decode/cluster    | `SEGMENT_KIND.chat = 9` (9+ reserved) + matching encode/decode/cluster |
| Replay    | **`frames` keyframe+delta** (`applyFrameDelta`)       | `replayState/chat.ts` — reducer from the nearest checkpoint            |
| UI        | runtime dock panel                                    | `AgentPanel` in **read-only replay mode** rendering the reduced state  |

**The one real gotcha — timeline anchoring.** Chat deltas arrive on async SSE callbacks from
Anthropic. Stamp each with the recorder's clock (`getRecordingTimestamp(session)`) **at capture
time** — never `Date.now()` rebased later. That mismatch is exactly the preview-drift bug already
fixed once. Because chat and workspace tracks then ride the **same** clock, "running `edit` on
`App.tsx`…" in the transcript lines up with the file change in the workspace track automatically —
no cross-track syncing needed.

**Checkpoints are the anti-drift mechanism.** Emit a `checkpoint` on a bounded cadence (e.g. every
~30 s of wall-clock or every _K_ messages), never per event — sparse enough that the
growing-transcript cost stays sub-dominant to the insert/remove deltas (which are O(total text), optimal).
Besides enabling seeks, a checkpoint **re-seats replay** if a delta is ever dropped or mis-ordered —
the same corrective-checkpoint fix that resolved the preview-replay append bug. Coalesce streamed
`text` deltas to ~10 Hz so recording stays a few events per second. **Capture only while a recording
session is active;** running the agent outside a recording captures nothing.

## 10. Build plan (decomposed, parallelizable)

Ordered by dependency; independent streams marked **∥** can be built in parallel.

**Phase 0 — Foundation (do first)**

1. Add `@anthropic-ai/sdk` (and `minimatch` if used) to `package.json`; confirm it builds under
   Vite/browser.
2. `src/agent/types.ts` — shared `Tool`, `AgentEvent`, `Credential` types.
3. `src/agent/tools/workspaceFs.ts` — read/list/mutate helpers over `workspaceStore` (the seam
   every tool depends on).

**Phase 1 — Parallel streams (after Phase 0)**

- **∥ A. Provider:** `anthropicClient.ts` (browser-mode Anthropic client) + `credentials.ts`.
- **∥ B. Tools:** `read`, `write`, `edit` (+ `editDiff.ts`), `ls`, `glob`, `grep`, `bash`, and
  `tools/index.ts` registries. Each tool is independently testable against a fake workspace store.
- **∥ C. Prompt:** `systemPrompt.ts` from workspace state.
- **∥ D. State:** `agentStore.ts` (messages/status/streamed text/error), mirroring
  `apiClientStore.ts`.

**Phase 2 — Integration** 4. `agentLoop.ts` — wire provider + tools + store + abort into the streaming loop. 5. `AgentPanel.tsx` — the CLI surface; mount in the editor chrome.

**Phase 3 — Chat recording & playback track (after Phase 2)** 6. Types + container: `ChatRecordingEvent` in `src/types/chat.ts`; add `chatEvents?` to `DeltaRecording` (`deltaTypes.ts`). 7. Capture: `appendChatDelta` in `recordingSession.ts` + `chatRecording.ts` emitting insert/remove deltas (coalesced ~10 Hz) and periodic checkpoints while a session records. 8. Codec: `SEGMENT_KIND.chat = 9` + the encode line, decode case, and cluster check; add a round-trip test. 9. Replay: `replayState/chat.ts` — reducer from the nearest checkpoint (mirrors the `frames` keyframe+delta apply), wire into the replay tick; `AgentPanel` read-only replay mode.

**Phase 4 — Hardening** 10. Unit tests per tool (fake store), a loop test (mocked SDK stream), credential-handling test, a chat-codec round-trip + chat-replay test. 11. `tsc` + `bun run test` green; author eyeballs the panel (no browser-automation verification —
per project convention).

Each tool + the loop should have a focused unit test; the tools are the natural unit of parallel
work.

## 11. Open decisions (need your call)

1. **CLI surface:** xterm-based CLI (on-brand, more code) vs. plain React transcript (simplest)?
2. **`bash` tool:** include it (WebContainer, desktop-only) or ship a file-only agent first?
3. **Approval gate:** none (pi-style) vs. a confirm on `bash`/`deleteFile`?
4. **Credential storage default:** memory-only (re-enter each session) vs. `sessionStorage` vs.
   opt-in `localStorage`?
5. **Checkpoint cadence:** how often to emit a chat `checkpoint` seek-anchor — every ~30 s of
   wall-clock, every _K_ messages, or both? (Delta encoding is decided; this only tunes seek
   granularity vs. size.)
6. **Agent edits as keystrokes:** replay agent file edits as content-delta "typing" (wire into the
   dmp stream) in v1, or accept file-state jumps and defer (see §9.1)?

_Decided: model default is **`claude-haiku-4-5`** (Haiku 4.5), user-switchable up to Sonnet/Opus.
Chat recording/playback is **delta-based** — insert/remove deltas + sparse corrective checkpoints, never
full-snapshot-per-event._

## 12. Appendix — pi source references

- Loop: `packages/agent/src/agent-loop.ts`, `agent.ts`, `types.ts`
- Tools: `packages/coding-agent/src/core/tools/{read,write,edit,ls,find,grep,bash}.ts`,
  `edit-diff.ts`, `system-prompt.ts`, `bash-executor.ts`
- Anthropic transport: `packages/ai/src/api/anthropic-messages.ts`,
  `providers/anthropic.ts`, `env-api-keys.ts`
- CLI shape: `packages/coding-agent/src/{cli,main}.ts`, `src/cli/args.ts`

---

### Recommended commit message (when this doc lands)

```
docs: add coding-agent plan (browser, workspace-store FS, Anthropic SDK)
```
