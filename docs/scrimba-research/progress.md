# Scrimba Research Progress

Last updated: 2026-06-14

## Current Status

This is a bundle-level research pass. It identifies the major architecture, action protocol, client-side stream persistence path, capture/branch behavior, the legacy-vs-modern workspace split, the modern workspace host/provider path, runtime request routing, and key differences from this repo's current recording architecture, but does not fully de-minify every class or server RPC boundary.

Overall status: partial, usable handoff.

## File Inventory And Research Status

| File                                |   Size | Status                                 | Summary                                                                                                                                                                                         |
| ----------------------------------- | -----: | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tmp/app.UK3DL7B2.js`               | 3.8 MB | Partially researched                   | Main platform/app bundle. Contains `Scrim*` content models, course/app/routing UI, AI provider/model objects, archivers, captions/audio models.                                                 |
| `tmp/chunks/ide.36BDFLCO.js`        | 2.8 MB | Partially researched, highest priority | IDE/player/runtime bundle. Contains action protocol, stream cursor, branches, timeline, Monaco-facing editor models, browser DOM replay, WebContainer runtime, workspace, AI workspace actions. |
| `tmp/scrim.blank.json.5TFCQ3DL.js`  |   2 KB | Researched                             | Default blank workspace layout/state snapshot.                                                                                                                                                  |
| `tmp/index.ZRFBPBWE.css`            | 1.1 MB | Not deeply researched                  | CSS for app/IDE. Has a `sourceMappingURL` to a missing CSS map. Useful later for UI class mapping.                                                                                              |
| `tmp/chunks/chunk.L47Z5YT6.js`      | 1.8 MB | Lightly classified                     | Monaco/editor infrastructure. Contains VS Code/Monaco code and language/editor behavior.                                                                                                        |
| `tmp/chunks/chunk.QMCWAF6X.js`      | 476 KB | Lightly classified                     | Shared UI/runtime framework, DOMPurify/marked-like support, Imba-ish runtime pieces.                                                                                                            |
| `tmp/chunks/chunk.TZHF2V3H.js`      | 256 KB | Lightly classified                     | CodeMirror/Lezer-style parser infrastructure.                                                                                                                                                   |
| `tmp/chunks/tsMode.4DHLWYKR.js`     |  24 KB | Lightly classified                     | Monaco TypeScript mode worker integration.                                                                                                                                                      |
| `tmp/chunks/chunk.BJMBBBNU.js`      |   6 KB | Lightly classified                     | Monaco TypeScript language contribution support.                                                                                                                                                |
| `tmp/chunks/chunk.TIEUX6A3.js`      |   5 KB | Lightly classified                     | Monaco TypeScript language setup/import shim.                                                                                                                                                   |
| `tmp/chunks/typescript.SIWHZMSK.js` |  <1 KB | Lightly classified                     | Imports TypeScript support chunks.                                                                                                                                                              |
| `tmp/chunks/chunk.5UVTBFB6.js`      |   1 KB | Lightly classified                     | Tiny shared module/bootstrap helper.                                                                                                                                                            |
| `tmp/arrow.HORQ22FG.png`            |   4 KB | Not researched                         | Static asset, probably cursor/pointer UI.                                                                                                                                                       |

## Completed Research Tasks

- Mapped file sizes, line counts, and bundle roles.
- Extracted import structure for major JavaScript bundles.
- Extracted custom element registrations.
- Extracted focused global model names related to Scrim, IDE, actions, timeline, browser, workspace, and AI.
- Extracted class-local method summaries for key Scrim and IDE classes.
- Extracted action opcode table and target IDs.
- Extracted partial stream framing behavior from `IDEStream.parsedValue`, `syncBuffer`, and `write`.
- Extracted client-side stream persistence behavior from `IDEStream.load`, `ScrimStream`, `OPDataStream`, `OPByteStream`, `OPBufferChunks`, `OPBinaryChunk`, and `OPBinaryChunkRequest`.
- Extracted capture paths for Monaco text edits/selections/scroll state, browser tracker action messages, pointer tracking, and modern audio recording.
- Extracted DOM mutation subprotocol.
- Extracted branch/editing/recording behavior from `IDEStream`.
- Extracted branch ancestry, fork creation, cursor route traversal, and exercise solution branch creation.
- Extracted workspace split between legacy `IDEFile`/`IDEFS` widget state and modern `SIWorkspace`/`SIFS` OP-diff state.
- Extracted host/provider sync path through `HostWorkspace`, `LocalWorkspace`, `WCWorkspace`, `HostFile`/`HostDir`, `SIWorkspace.host`, and `SIWebContainer`.
- Extracted runtime request routing through `ide-sw-container`, `ServiceWorkerFrame`, `runner-frame`, `player-frame`, `scrim-view.oncontainermessage`, and `SIWebContainer` bridge handling.
- Compared Scrimba's action stream architecture with this repo's frame/delta recording, workspace/runtime snapshot, storage codec, and WebContainer provider approach.
- Inspected `scrim.blank.json` manually.
- Wrote durable research docs:
  - `README.md`
  - `findings.md`
  - `action-protocol.md`
  - this `progress.md`

## Key Classes Already Summarized

### App/Content Bundle

Researched enough for a high-level summary:

- `Scrim`
- `ScrimStream`
- `ScrimSnapshot`
- `ScrimRec`
- `ScrimCommit`
- `ScrimClip`
- `ScrimPractice`
- `ScrimPreview`
- `ScrimAudio`
- `ScrimAudioTrack`
- `OPDataStream`
- `OPByteStream`
- `OPBufferChunks`
- `OPBinaryChunk`
- `OPBinaryChunkRequest`
- `HostFSEntry`
- `HostFile`
- `HostDir`
- `HostFSRoot`
- `HostWorkspace`
- `LocalWorkspace`
- `WCWorkspace`
- `Caption`
- `Captions`
- `ScrimArchiver`
- `ViteScrimArchiver`
- `WebpackScrimArchiver`
- `WSPScrimArchiver`
- `AppIDE`

### IDE/Runtime Bundle

Researched enough for a high-level summary:

- `IDEStream`
- `IDEStreamAction`
- `IDEStreamCursor`
- `IDEBranch`
- `IDETrunk`
- `IDESolutionBranch`
- `IDEBranchTimeline`
- `BaseTimeline`
- `ClipTimeline`
- `IDEEditor`
- `IDEFile`
- `IDEFS`
- `IDEBrowser`
- `BrowserPage`
- `IDEBrowserHistory`
- `ServiceWorkerFrame`
- `ide-sw-container`
- `runner-frame`
- `player-frame`
- `browser-widget`
- `IDEConsole`
- `IDEPointer`
- `SIObject`
- `SIFSEntry`
- `SIFile`
- `SIDir`
- `SIWorkspace`
- `SIFS`
- `SIBrowser`
- `SIWebContainer`
- `SIWebContainerPort`
- `SIRunner`
- `SITerminal`
- `SIWebConsole`

Action classes directly inspected:

- `TextEditAction`
- `TextInsertAction`
- `TextDeleteAction`
- `TextSelectionAction`
- `TextScrollAction`
- `ViewOpenAction`
- `ViewCloseAction`
- `FSMoveAction`
- `DOMMutateAction`
- `PageLoadAction`
- `PageLogAction`
- `SnapshotAction`
- `KeyframeAction`
- `SaveAction`
- `MarkerAction`
- `RecStartAction`
- `RecStopAction`
- `IDEPointerUpdateAction`
- `PointerUpdateGroup`
- `AudioRecording`
- `MediaStreamAction`
- `MediaStreamStartAction`
- `MediaStreamEndAction`
- `IDEOPSnapshotAction`
- `IDEOPDeltaAction`
- `ForkAction`
- `BranchAction`
- `SeedAction`
- `TrimActionAction`
- `SIRollbackAction`

## Commands Used

These commands are safe to rerun from the repo root.

### Inventory

```bash
rg --files tmp
find tmp -maxdepth 3 -type f -print0 | xargs -0 du -h | sort -hr
wc -l tmp/*.js tmp/chunks/*.js tmp/*.css
```

### Keyword Search

Do not run broad `rg` without output limits on these bundles; many files are minified into extremely long lines.

```bash
rg -n "Scrimba|scrimba|scrim|Scrim|record|playback|timeline|browser|workspace|WebContainer|monaco|postMessage" tmp -S
```

### Extract Bundle Metadata

```bash
python3 - <<'PY'
import re, pathlib
for path in pathlib.Path('tmp').glob('**/*.js'):
    text = path.read_text(errors='ignore')
    imports = re.findall(r'import[^;]+;', text[:20000], re.S)
    elems = re.findall(r'\bge\("([^"]+)"\s*,', text)
    globals_ = re.findall(r'globalThis\.([A-Za-z_$][\w$]*)', text)
    print(f"\n### {path} ({len(text):,} chars)")
    print("imports:", len(imports))
    print("custom-elements:", len(elems), sorted(set(elems))[:120])
    print("globalThis:", sorted(set(globals_))[:120])
PY
```

### Extract Focused Runtime Names

```bash
python3 - <<'PY'
import re, pathlib
for path in [pathlib.Path('tmp/chunks/ide.36BDFLCO.js'), pathlib.Path('tmp/app.UK3DL7B2.js')]:
    text = path.read_text(errors='ignore')
    names = sorted(set(re.findall(r'globalThis\.([A-Za-z_$][\w$]*)', text)))
    focus = [n for n in names if re.search(r'Scrim|IDE|Timeline|Action|Browser|Stream|Branch|Clip|Widget|Page|Console|FS|Slide|Audio|AI|Agent|Workspace|Runner|Recorder|Pointer|DOM|Layout', n)]
    print(f"\n### {path}: {len(focus)} focused globals")
    for n in focus:
        print(n)
PY
```

### Extract Action Opcode Table

```bash
python3 - <<'PY'
from pathlib import Path
text = Path('tmp/chunks/ide.36BDFLCO.js').read_text(errors='ignore')
idx = text.find('me.SET=1;')
print('offset', idx)
print(text[idx:idx+1700])
PY
```

### Inspect Key Class Segments

This script extracts method names and selected strings for registered classes. Add class names to `classes` as needed.

```bash
python3 - <<'PY'
import re, pathlib
classes = ['IDEStreamAction','IDEStreamCursor','BrowserPage','SIWebContainer','Scrim','ScrimStream']
files = [pathlib.Path('tmp/app.UK3DL7B2.js'), pathlib.Path('tmp/chunks/ide.36BDFLCO.js')]
reg_cache = {}
for path in files:
    text = path.read_text(errors='ignore')
    for m in re.finditer(r'\b[HA]\(([A-Za-z_$][\w$]*)\s*,[^;]{0,120}?"([A-Za-z0-9_.$ -]+)"\s*,\s*\d+\)', text):
        reg_cache.setdefault(m.group(2), []).append((path, text, m.group(1), m.start()))

def find_class_segment(text, ident, regpos):
    starts = list(re.finditer(r'(?:var|let|const)\s+' + re.escape(ident) + r'\s*=\s*class\b', text[:regpos]))
    if not starts:
        starts = list(re.finditer(r'\b' + re.escape(ident) + r'\s*=\s*class\b', text[:regpos]))
    if not starts:
        return None
    st = starts[-1].start()
    class_kw = text.find('class', st)
    brace = text.find('{', class_kw)
    depth = 0
    i = brace
    in_s = None
    esc = False
    while i < len(text):
        ch = text[i]
        if in_s:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == in_s:
                in_s = None
        else:
            if ch in ('"', "'", '`'):
                in_s = ch
            elif ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    return text[st:i+1]
        i += 1
    return text[st:regpos]

for cls in classes:
    entries = reg_cache.get(cls, [])
    if not entries:
        print('missing', cls)
        continue
    path, text, ident, pos = entries[0]
    seg = find_class_segment(text, ident, pos)
    print(f"\n### {cls} [{path.name}] ident={ident} chars={len(seg) if seg else 0}")
    if seg:
        methods = []
        for m in re.finditer(r'(?:^|[{};])\s*(async\s+)?(?:(get|set)\s+)?([A-Za-z_$][\w$ΞΦα]+)\s*\(', seg):
            name = ((m.group(1) or '') + (m.group(2) + ' ' if m.group(2) else '') + m.group(3)).strip()
            if name not in methods:
                methods.append(name)
        print(', '.join(methods[:120]))
PY
```

## Next Recommended Tasks

1. Continue stream persistence:
   - Trace the server-facing `load_from_prod` RPC call site as far as possible from client metadata.
   - Look for any client-visible backend route declarations for `/legacy/files/` and `/op/stream/`.
   - Trace how `ScrimRec.byte_offset`, media chunks, and stream byte offsets relate.

2. Trace capture paths:
   - Deeply inspect the external tracker bundle if it becomes available; the local bundle references `/assets/tracker.4FYFXZYK.iife.js` but the file is not present under `tmp/`.
   - Confirm whether `LCSCROLL` has a producer in another bundle revision or is legacy-only.
   - Confirm whether `MSR_CHUNK` has a producer in another bundle revision or is legacy-only.
   - Further trace pointer rendering in `IDEPointer`/`PointerFrame`.

3. Trace branch semantics:
   - Trace any server-side meaning exposed by `COMMIT=220`; no registered `CommitAction` class was found in this pass.
   - Inspect commit creation UI/actions around `ScrimCommit` and `ide-commit-dialog`.
   - Trace route/path behavior for nested scribbles and solutions beyond the creation path.

4. Deepen workspace host/provider sync:
   - Trace host-side implementations of `LocalWorkspace.merge`, `WCWorkspace.merge`, `WCWorkspace.install`, and `WCWorkspace.serializeDir`.
   - Trace how WebContainer bridge messages implement the RPC-facing `WCWorkspace` actions.
   - Confirm where host diffs/save payloads are persisted after `HostWorkspace.$changed` throttles `save()`.

5. Trace runtime request routing:
   - Locate or reconstruct the standalone `/__sw__.html`, `/__sw__blank.html`, and `/__sw__tracker.js` artifacts if they exist outside the inspected bundle.
   - Deepen the WebContainer bridge protocol around `.bootstrap.mjs`, reserved bridge port handling, and OP-packed `ArrayBuffer` messages.
   - Trace external tracker bundle behavior if `/assets/tracker.4FYFXZYK.iife.js` becomes available.

6. Product architecture follow-up:
   - Decide whether Next Editor should pursue Scrimba-compatible reversible action streams or keep its existing frame/delta recording artifact model.
   - If pursuing parity, map Scrimba `LC*`, DOM/page, pointer, media, and `OPSNAPSHOT`/`OPDELTA` concepts to concrete Next Editor modules.
   - If keeping the current model, document which Scrimba capabilities are intentionally out of scope or need separate abstractions.

## Notes For Future Agents

- Prefer targeted regex extraction over direct `rg` line output; the minified bundles have very long lines and can flood context.
- Use character offsets when line numbers are unhelpful.
- Preserve "confirmed" vs "inferred" distinctions.
- Keep adding to these docs as research progresses.
- If creating de-minified extracts, store only small targeted snippets or summaries to avoid committing massive generated files.
