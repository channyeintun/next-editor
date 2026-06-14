# Scrimba Research Progress

Last updated: 2026-06-14

## Current Status

This is an initial bundle-level research pass. It identifies the major architecture and action protocol but does not fully de-minify every class.

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
- Extracted DOM mutation subprotocol.
- Extracted branch/editing/recording behavior from `IDEStream`.
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
- `IDEConsole`
- `IDEPointer`
- `SIWorkspace`
- `SIFS`
- `SIBrowser`
- `SIWebContainer`
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

1. Decode stream persistence:
   - Trace `IDEStream` load/deserialization methods.
   - Trace `ScrimStream.httpUrl` and `/legacy/files/`.
   - Extend the current msgpack framing notes with the actual backing stream object and server storage format.

2. Trace capture paths:
   - Monaco edit/selection/scroll event capture into `LC*` actions.
   - Browser tracker script generation and DOM mutation capture.
   - Pointer update capture and rendering.
   - Media stream chunk capture (`MSR_START`, `MSR_CHUNK`, `MSR_END`).

3. Trace branch semantics:
   - `IDEBranch.load` and the exact `IDEStream.load` method body.
   - branch path/routing
   - `ForkAction`, `BranchAction`, `CommitAction`, `TrimActionAction`
   - solution/exercise branch creation from `ScrimPractice`.

4. Trace workspace split:
   - legacy `IDEFile`/`IDEFS` widget model
   - modern `SIWorkspace`/`SIFS` model
   - conversion or compatibility paths.

5. Trace runtime request routing:
   - `ide-sw-container`
   - `ServiceWorkerFrame`
   - `runner-frame`/`player-frame`
   - `oncontainermessage`
   - WebContainer preview messages.

6. Compare with this repo's implementation:
   - `src/core`
   - `docs/core.md`
   - `docs/data-flow.md`
   - `docs/state-machines.md`

## Notes For Future Agents

- Prefer targeted regex extraction over direct `rg` line output; the minified bundles have very long lines and can flood context.
- Use character offsets when line numbers are unhelpful.
- Preserve "confirmed" vs "inferred" distinctions.
- Keep adding to these docs as research progresses.
- If creating de-minified extracts, store only small targeted snippets or summaries to avoid committing massive generated files.
