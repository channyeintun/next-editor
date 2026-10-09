import { useDocumentTitle } from "../hooks/useDocumentTitle";

const styles = `
.arch-page{
  --arch-page-bg:#e4e9ee;
  --paper:#eef2f6; --paper-strong:#e2e9f1; --grid-line:#c9d6e3;
  --ink:#14243a; --ink-soft:#4a5d75; --ink-faint:#56687f;
  --blue:#2f6fa8; --blue-fill:#dce7f0;
  --redline:#b23a2e; --redline-fill:#f6e3e0;
  --dashline:#5f7790;
  --font-mono: ui-monospace,"SF Mono","Cascadia Code","JetBrains Mono",Menlo,Consolas,monospace;
  --font-sans: -apple-system,"Segoe UI",system-ui,"Helvetica Neue",Arial,sans-serif;
}
@media (prefers-color-scheme: dark){
  .arch-page{
    --arch-page-bg:#081a30;
    --paper:#0d2542; --paper-strong:#123055; --grid-line:#1f4870;
    --ink:#eaf3fb; --ink-soft:#a9c6e2; --ink-faint:#6f93b8;
    --blue:#7fb3d9; --blue-fill:#163a5c;
    --redline:#ff8b72; --redline-fill:#4a2420;
    --dashline:#4d719a;
  }
}
.arch-page{
  min-height:100dvh; background:var(--arch-page-bg);
  font-family:var(--font-sans); color:var(--ink);
  padding:32px 16px 64px; display:flex; justify-content:center;
}
.arch-page *{ box-sizing:border-box; }
.arch-page .page-inner{ width:100%; max-width:1360px; }
.arch-page .sheet{
  background:var(--paper); color:var(--ink);
  border:1px solid var(--grid-line); border-radius:2px;
  box-shadow:0 1px 3px rgba(0,0,0,0.08);
}
.arch-page code{ font-family:var(--font-mono); }
.arch-page .titleblock{
  display:flex; justify-content:space-between; align-items:flex-end;
  gap:24px; padding:28px 32px 20px; border-bottom:1px solid var(--grid-line);
  flex-wrap:wrap;
}
.arch-page .titleblock h1{
  font-family:var(--font-mono); font-weight:500; font-size:26px; letter-spacing:-0.01em;
  margin:0 0 6px; text-wrap:balance;
}
.arch-page .titleblock .sub{ font-size:14px; color:var(--ink-soft); max-width:52ch; line-height:1.5; margin:0;}
.arch-page .meta{
  display:grid; grid-template-columns:repeat(4,auto); gap:2px 22px;
  font-family:var(--font-mono); font-size:11px; color:var(--ink-faint);
  border-top:1px solid var(--grid-line); padding-top:8px;
}
.arch-page .meta b{ color:var(--ink-soft); font-weight:500; display:block; letter-spacing:.04em; font-size:10px; margin-bottom:2px;}
.arch-page .meta span{ color:var(--ink); font-variant-numeric:tabular-nums; }
.arch-page .diagram-wrap{ padding:8px 20px 4px; overflow-x:auto; }
.arch-page .diagram-wrap svg{ display:block; min-width:820px; }
.arch-page .legend{
  display:flex; flex-wrap:wrap; gap:18px 28px; align-items:center;
  padding:14px 32px 26px; font-size:12px; color:var(--ink-soft);
  border-bottom:1px solid var(--grid-line);
}
.arch-page .legend-item{ display:flex; align-items:center; gap:8px; }
.arch-page .swatch{ width:20px; height:12px; flex:none; border-radius:1px; }
.arch-page .swatch.solid{ background:var(--blue-fill); border:1.4px solid var(--blue); }
.arch-page .swatch.dash{ background:transparent; border:1.4px dashed var(--dashline); }
.arch-page .swatch.arrow{ width:20px; height:0; border-top:1.4px solid var(--ink-soft); }
.arch-page .swatch.arrow.dashed{ border-top-style:dashed; }
.arch-page .tagdot{ width:16px; height:16px; border-radius:50%; background:var(--redline-fill); color:var(--redline); border:1.2px solid var(--redline); font-family:var(--font-mono); font-size:9px; display:flex; align-items:center; justify-content:center; flex:none; }
.arch-page .notes{ padding:24px 32px 8px; }
.arch-page .notes h2, .arch-page .build h2{
  font-family:var(--font-mono); font-size:13px; font-weight:500; letter-spacing:.04em;
  text-transform:uppercase; color:var(--ink-soft); margin:0 0 14px;
}
.arch-page .notes-grid{ display:grid; grid-template-columns:repeat(2,1fr); gap:8px 32px; }
.arch-page .note{ display:flex; gap:10px; font-size:13px; line-height:1.5; align-items:baseline; }
.arch-page .note .n{ font-family:var(--font-mono); color:var(--redline); font-size:12px; flex:none; width:1.4em; }
.arch-page .note b{ font-weight:500; color:var(--ink); }
.arch-page .note .d{ color:var(--ink-soft); }
.arch-page .build{ padding:8px 32px 32px; }
.arch-page .build h2{ margin-top:24px; }
.arch-page .spec-table{ width:100%; border-collapse:collapse; font-size:13px; }
.arch-page .spec-table tr{ border-bottom:1px solid var(--grid-line); }
.arch-page .spec-table tr:last-child{ border-bottom:none; }
.arch-page .spec-table td{ padding:9px 14px 9px 0; vertical-align:top; }
.arch-page .spec-table td:first-child{
  font-family:var(--font-mono); color:var(--ink-soft); font-size:11px;
  letter-spacing:.03em; white-space:nowrap; width:1%; padding-top:11px;
}
.arch-page .spec-table td:last-child code{
  color:var(--ink); background:var(--blue-fill); padding:2px 7px; border-radius:3px;
  font-size:12px; margin-right:6px; display:inline-block; margin-bottom:4px;
}
.arch-page .spec-table td:last-child .note-inline{ color:var(--ink-faint); font-size:12px; }
@media (max-width: 640px){
  .arch-page .notes-grid{ grid-template-columns:1fr; }
  .arch-page .titleblock{ padding:22px 18px 16px; }
  .arch-page .diagram-wrap{ padding:8px 8px 4px; }
  .arch-page .notes, .arch-page .build{ padding-left:18px; padding-right:18px; }
}
`;

interface ChipProps {
  x: number;
  y: number;
  width: number;
  title: string;
  lines: string[];
  tag: number;
}

function Chip({ x, y, width, title, lines, tag }: ChipProps) {
  const height = lines.length > 1 ? 80 : 72;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={4}
        fill="var(--blue-fill)"
        stroke="var(--blue)"
        strokeWidth={1}
      />
      <text
        x={x + 16}
        y={y + 24}
        fontFamily="var(--font-mono)"
        fontSize={13}
        fontWeight={500}
        fill="var(--ink)"
      >
        {title}
      </text>
      {lines.map((line, i) => (
        <text
          key={line}
          x={x + 16}
          y={y + 42 + i * 14}
          fontSize={lines.length > 1 ? 11 : 11.5}
          fill="var(--ink-soft)"
        >
          {line}
        </text>
      ))}
      <circle
        cx={x + width - 16}
        cy={y + 16}
        r={11}
        fill="var(--redline-fill)"
        stroke="var(--redline)"
        strokeWidth={1}
      />
      <text
        x={x + width - 16}
        y={y + 16}
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="var(--font-mono)"
        fontSize={10}
        fill="var(--redline)"
      >
        {tag}
      </text>
    </g>
  );
}

// Every external box is this tall; the connector meets its left edge halfway.
const EXTERNAL_BOX_HEIGHT = 96;

interface ExternalBoxProps {
  x: number;
  y: number;
  title: string;
  lines: string[];
  tag: number;
  /** Absolute x where the inbound connector begins. Defaults to x - 48 (a
   *  direct line from the layer box). Boxes that hang off a shared bus pass
   *  the bus x so the connector branches from it instead of dangling. */
  connectorStartX?: number;
}

function ExternalBox({ x, y, title, lines, tag, connectorStartX }: ExternalBoxProps) {
  const connectorY = y + EXTERNAL_BOX_HEIGHT / 2;
  return (
    <g>
      <line
        x1={connectorStartX ?? x - 48}
        y1={connectorY}
        x2={x - 4}
        y2={connectorY}
        stroke="var(--dashline)"
        strokeWidth={1.4}
        strokeDasharray="4 4"
        markerEnd="url(#arch-arrow-dash)"
      />
      <rect
        x={x}
        y={y}
        width={332}
        height={EXTERNAL_BOX_HEIGHT}
        rx={6}
        fill="none"
        stroke="var(--dashline)"
        strokeWidth={1.4}
        strokeDasharray="5 4"
      />
      <text
        x={x + 22}
        y={y + 28}
        fontFamily="var(--font-mono)"
        fontSize={13}
        fontWeight={500}
        fill="var(--ink)"
      >
        {title}
      </text>
      {lines.map((line, i) => (
        <text key={line} x={x + 22} y={y + 47 + i * 17} fontSize={11.5} fill="var(--ink-soft)">
          {line}
        </text>
      ))}
      <circle
        cx={x + 300}
        cy={y + 16}
        r={11}
        fill="var(--redline-fill)"
        stroke="var(--redline)"
        strokeWidth={1}
      />
      <text
        x={x + 300}
        y={y + 16}
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="var(--font-mono)"
        fontSize={10}
        fill="var(--redline)"
      >
        {tag}
      </text>
    </g>
  );
}

type ChipSpec = Omit<ChipProps, "x" | "y" | "width">;

const clientChips: ChipSpec[] = [
  {
    title: "React 19 + Compiler",
    lines: ["one SPA: /code /learn /studio", "compiler memoizes, no manual memo"],
    tag: 1,
  },
  {
    title: "Monaco editor",
    lines: ["multi-file editing surface +", "zig/haskell/kite/asm grammars"],
    tag: 2,
  },
  {
    title: "xstate · store-react",
    lines: ["recorder/player state machine", "+ app-level stores"],
    tag: 3,
  },
  {
    title: "WebContainer + xterm",
    lines: ["Node.js in the browser: 12 lesson", "types, preview + terminal tabs"],
    tag: 4,
  },
  {
    title: "in-page runners",
    lines: ["Kite on a Wasm build of kitec,", "x86-64 assembler + machine (TS)"],
    tag: 5,
  },
  {
    title: "sandboxed iframes",
    lines: ["preview + slides under strict", "CSP; postMessage bridges"],
    tag: 6,
  },
  {
    title: "rrweb",
    lines: ["preview DOM, scroll + input as", "events, corrective snapshots"],
    tag: 7,
  },
  {
    title: "MediaRecorder · WebCodecs",
    lines: ["narration, camera, local screen", "capture; edits → Ogg/Opus"],
    tag: 8,
  },
  {
    title: "SCR3 codec",
    lines: ["dmp (Rust→WASM) + msgpack + fflate", "in a worker; plays mid-download"],
    tag: 9,
  },
  {
    title: "IndexedDB · OPFS",
    lines: ["drafts, assets, learner versions;", "large .ne payloads in OPFS"],
    tag: 10,
  },
  {
    title: "Excalidraw",
    lines: ["whiteboard, loaded on demand;", "records element deltas"],
    tag: 11,
  },
  {
    title: "slides",
    lines: ["markdown (marked) or html, or", "Google Slides decks as SVG"],
    tag: 12,
  },
  {
    title: "ONNX Runtime Web",
    lines: ["on-device Whisper captions", "+ Pocket TTS narration"],
    tag: 13,
  },
  {
    title: "coding agent",
    lines: ["@openrouter/agent, user's own key;", "chat recorded into the lesson"],
    tag: 14,
  },
  {
    title: "Studio performer",
    lines: ["LessonScript → plan → real editor", "→ QA gates → draft lesson"],
    tag: 15,
  },
  {
    title: "Yjs + y-monaco",
    lines: ["room edits + awareness over", "binary WebSockets; follow"],
    tag: 16,
  },
  {
    title: "partytracks · WebRTC",
    lines: ["audio-only room voice via the", "Cloudflare Realtime SFU"],
    tag: 17,
  },
  {
    title: "PostHog SDK",
    lines: ["analytics, masked replay,", "exceptions → PostHog (US)"],
    tag: 18,
  },
];

const edgeChips: ChipSpec[] = [
  {
    title: "Hono API routes",
    lines: ["lessons, playlists, search,", "uploads, rooms + voice, studio"],
    tag: 19,
  },
  {
    title: "assets + edge SSR",
    lines: ["dist/ via ASSETS, COOP/COEP on", "every response; SSR landing"],
    tag: 20,
  },
  {
    title: "auth",
    lines: ["Google OAuth + One Tap, passkeys;", "D1-backed session cookie"],
    tag: 21,
  },
  {
    title: "playground proxies",
    lines: ["go · kotlin · rust · zig · haskell", "kill switch · cache · rate limit"],
    tag: 22,
  },
  {
    title: "/api/openrouter",
    lines: ["streams the agent's model calls;", "CORS pass-through, holds no key"],
    tag: 23,
  },
  {
    title: "/api/proxy",
    lines: ["SSRF-guarded https fetch: slide", "images, avatars, remote .ne"],
    tag: 24,
  },
];

const storageChips: ChipSpec[] = [
  {
    title: "D1 (SQLite)",
    lines: ["users, sessions, passkeys, lessons,", "playlists, rooms, encrypted API keys"],
    tag: 25,
  },
  {
    title: "R2 (object storage)",
    lines: ["lesson media + captions, slide", "images, private room assets"],
    tag: 26,
  },
  {
    title: "Workers KV",
    lines: ["playground Run/Format", "results; fail-open"],
    tag: 27,
  },
  {
    title: "Room Durable Objects",
    lines: ["binary WebSockets + SQLite Yjs", "log, compacted on an alarm"],
    tag: 28,
  },
  {
    title: "Voice Durable Objects",
    lines: ["voice roster + capabilities;", "sole gateway to the SFU API"],
    tag: 29,
  },
  {
    title: "Rate Limiting",
    lines: ["playground + AthanLab budgets,", "per user or per IP; fail closed"],
    tag: 30,
  },
];

type ExternalSpec = Omit<ExternalBoxProps, "x" | "y" | "connectorStartX">;

// Services the browser reaches directly, without the Worker in between.
const browserServices: ExternalSpec[] = [
  {
    title: "StackBlitz",
    lines: ["WebContainer runtime iframe,", "stackblitz.com/headless"],
    tag: 31,
  },
  {
    title: "Google Slides",
    lines: ["published decks, fetched by the", "browser at import"],
    tag: 32,
  },
  {
    title: "Hugging Face",
    lines: ["Whisper + Pocket TTS weights,", "pinned revisions, cached"],
    tag: 33,
  },
  {
    title: "PostHog Cloud (US)",
    lines: ["analytics, masked session", "replay, exception reports"],
    tag: 34,
  },
];

// Services only the Worker (or one of its Durable Objects) calls.
const workerServices: ExternalSpec[] = [
  {
    title: "Google Identity",
    lines: ["OAuth 2.0 code exchange,", "One Tap token verification"],
    tag: 35,
  },
  {
    title: "language playgrounds",
    lines: [
      "play.golang.org · api.kotlinlang.org",
      "play.rust-lang.org · zig-play.dev",
      "play.haskell.org",
    ],
    tag: 36,
  },
  {
    title: "OpenRouter",
    lines: ["model API for the coding agent,", "called with the user's own key"],
    tag: 37,
  },
  {
    title: "AthanLab",
    lines: ["Burmese Studio narration with the", "user's own encrypted key"],
    tag: 38,
  },
  {
    title: "Modal · VoxCPM2",
    lines: ["Burmese Studio narration,", "gated by a D1 feature flag"],
    tag: 39,
  },
  {
    title: "Upstash QStash",
    lines: ["signed callback purges a", "room 7 days after it closes"],
    tag: 40,
  },
  {
    title: "Cloudflare Realtime SFU",
    lines: ["audio-only WebRTC media plane,", "Opus fan-out between members"],
    tag: 41,
  },
];

const notes: Array<{ n: string; title: string; detail: string }> = [
  {
    n: "01",
    title: "React 19 + Compiler",
    detail:
      "one SPA for the landing page, /code, /learn, /studio, and this sheet; the compiler memoizes, so there is no manual useCallback/useMemo.",
  },
  {
    n: "02",
    title: "Monaco editor",
    detail:
      "edits the multi-file workspace, with first-party grammars for Zig, Haskell, Kite, and x86-64 assembly.",
  },
  {
    n: "03",
    title: "xstate + store-react",
    detail:
      "the recorder/player machine owns the timeline; app-level stores hold the workspace, slides, whiteboard, and settings.",
  },
  {
    n: "04",
    title: "WebContainer + xterm.js",
    detail:
      "Node.js in the browser for 12 lesson types (Vite apps, Express, JavaScript/TypeScript, Kite web, WASI Python), with a preview and terminal tabs.",
  },
  {
    n: "05",
    title: "In-page runners",
    detail:
      "Kite compiles on a Wasm build of kitec, and assembly runs on a first-party NASM-syntax assembler and x86-64 Linux machine; neither calls a service.",
  },
  {
    n: "06",
    title: "Sandboxed iframes",
    detail:
      "the live preview and every slide render in sandboxed frames; slides run no script except a nonce-locked animation driver for Google decks.",
  },
  {
    n: "07",
    title: "rrweb",
    detail:
      "records the preview's DOM, scroll, and input as one event stream, with corrective full snapshots, and replays it on the recording clock.",
  },
  {
    n: "08",
    title: "MediaRecorder + WebCodecs",
    detail:
      "narration, camera, and a screen capture that is only saved locally; cut, muted, or retaken narration is re-encoded to Ogg/Opus.",
  },
  {
    n: "09",
    title: "SCR3 codec",
    detail:
      "keyframes and deltas (exact Monaco edits or Rust→WASM diff-match-patch) in msgpack + fflate segments, decodable from any prefix so playback starts mid-download.",
  },
  {
    n: "10",
    title: "IndexedDB + OPFS",
    detail:
      "crash-recovery drafts, workspace assets by SHA-256, and learner versions; .ne payloads of 8 MiB or more go to OPFS.",
  },
  {
    n: "11",
    title: "Excalidraw",
    detail: "the whiteboard, loaded on demand; records element deltas, not full snapshots.",
  },
  {
    n: "12",
    title: "Slides",
    detail:
      "Markdown (marked) or HTML slides, or a published Google Slides deck imported as SVG with its build steps.",
  },
  {
    n: "13",
    title: "ONNX Runtime Web",
    detail:
      "Whisper captions and Pocket TTS narration run on the device; the weights are kept in Cache Storage.",
  },
  {
    n: "14",
    title: "Coding agent",
    detail:
      "@openrouter/agent with the user's own key; file tools everywhere, plus preview inspection and confirmed shell commands in WebContainer lessons. The chat is recorded.",
  },
  {
    n: "15",
    title: "Studio performer",
    detail:
      "compiles a LessonScript into a timed plan, drives the real editor while the recorder captures it, and hands a render that passes QA to the upload flow as a draft.",
  },
  {
    n: "16",
    title: "Yjs + y-monaco",
    detail:
      "room documents and awareness over binary WebSockets; any participant can follow another's file, slide, or whiteboard.",
  },
  {
    n: "17",
    title: "partytracks + WebRTC",
    detail:
      "audio-only voice chat; join is muted, unmute publishes one Opus track, mute releases the mic. Remote voice never enters the recorder.",
  },
  {
    n: "18",
    title: "PostHog SDK",
    detail:
      "autocapture + custom events, exception capture, privacy-masked session replay (inputs masked, Monaco/Excalidraw blocked); replay pauses during lesson recording.",
  },
  {
    n: "19",
    title: "Hono API routes",
    detail:
      "lessons, playlists, authors, search, uploads, collaboration + voice, Studio, and slide images; CSRF-guarded and logged per request.",
  },
  {
    n: "20",
    title: "Assets + edge SSR",
    detail:
      "every request runs the Worker first so static files get COOP/COEP too; the landing page renders at the edge, and lesson pages get real metadata.",
  },
  {
    n: "21",
    title: "Auth",
    detail:
      "Google OAuth (PKCE) and One Tap create accounts, passkeys sign in to them, and the session is an opaque cookie looked up in D1.",
  },
  {
    n: "22",
    title: "Playground proxies",
    detail:
      "Go, Kotlin, Rust, Zig, and Haskell runs with no sign-in needed, each behind a kill switch, a rate limit (per user, or per IP when signed out), and a one-hour result cache.",
  },
  {
    n: "23",
    title: "/api/openrouter",
    detail:
      "forwards the agent's streamed model calls so the SDK's headers clear CORS; it stores and logs no key.",
  },
  {
    n: "24",
    title: "/api/proxy",
    detail:
      "https-only fetch that blocks loopback and private hosts; serves slide-image fallbacks, avatars, and cross-origin .ne files.",
  },
  {
    n: "25",
    title: "D1",
    detail:
      "users, sessions, passkeys, lessons, playlists, per-user feature flags, users' provider API keys (AthanLab) encrypted by the Worker with AES-256-GCM, a failed-sign-in breaker, and the collaboration room and access-control plane.",
  },
  {
    n: "26",
    title: "R2",
    detail:
      "lesson media (.ne, audio, camera, captions, thumbnails), imported slide images, and private content-addressed collaboration assets.",
  },
  {
    n: "27",
    title: "Workers KV",
    detail:
      "playground Run/Format results; eventually consistent and fail-open. The public lesson/playlist catalog reads D1 directly.",
  },
  {
    n: "28",
    title: "Room Durable Objects",
    detail:
      "hibernating binary WebSockets, authoritative awareness, and a per-room SQLite Yjs log compacted on an alarm.",
  },
  {
    n: "29",
    title: "Voice Durable Objects",
    detail:
      "per-room voice roster and per-connection capabilities; the only path to the SFU API — validates session/track/mid ownership before proxying.",
  },
  {
    n: "30",
    title: "Rate Limiting",
    detail:
      "budgets for the playground proxies (per user, or per IP when signed out) and for AthanLab key checks and narration calls (per user); a route whose binding is missing refuses the request instead of calling out.",
  },
  {
    n: "31",
    title: "StackBlitz",
    detail: "the WebContainer runtime boots in a hidden iframe from stackblitz.com.",
  },
  {
    n: "32",
    title: "Google Slides",
    detail:
      "the browser fetches a published deck directly; the Worker copies its Google-hosted images into R2.",
  },
  {
    n: "33",
    title: "Hugging Face",
    detail: "Whisper and Pocket TTS weights at pinned revisions, downloaded once per browser.",
  },
  {
    n: "34",
    title: "PostHog Cloud (US)",
    detail:
      "receives analytics, masked replay, and error reports; edge request logs carry X-POSTHOG-* ids to cross-link them.",
  },
  {
    n: "35",
    title: "Google Identity",
    detail: "OAuth code exchange, and One Tap token checks against Google's published keys.",
  },
  {
    n: "36",
    title: "Language playgrounds",
    detail:
      "play.golang.org, api.kotlinlang.org (Kotlin 2.4.10), play.rust-lang.org, zig-play.dev (Zig 0.16.0), and play.haskell.org (GHC 9.12.4).",
  },
  {
    n: "37",
    title: "OpenRouter",
    detail: "the model API behind the coding agent, called with the user's own key.",
  },
  {
    n: "38",
    title: "AthanLab",
    detail:
      "Burmese Studio narration with the user's own encrypted key. Only the Worker calls api.athanlab.com, as AthanLab's terms require; each uncached dialog is one job charged to the user's AthanLab balance. A D1 breaker admits at most 8 failing key checks per 5-minute window (16 in any 5 minutes, under the 20 that make AthanLab block our shared network), and a per-user D1 lease, bound to the sealed key, holds other requests with the same stored key back until AthanLab has answered the first, so a revoked key is not rejected once per concurrent request.",
  },
  {
    n: "39",
    title: "Modal · VoxCPM2",
    detail:
      "Burmese Studio narration for users with the studio.burmese-voxcpm2 D1 flag; the Modal credentials stay in the Worker.",
  },
  {
    n: "40",
    title: "Upstash QStash",
    detail:
      "seven days after a room closes, a signed job purges its Durable Object document, R2 assets, and D1 rows.",
  },
  {
    n: "41",
    title: "Cloudflare Realtime SFU",
    detail:
      "Opus audio forwarding between room members over DTLS-SRTP; roomless by design, so the app decides who may subscribe. Feature-flagged via VOICE_CHAT_ENABLED.",
  },
];

// Diagram geometry. Layers stack in the left column; external services hang
// off a dashed bus in the right column, grouped by which layer calls them.
const LAYER_X = 40;
const LAYER_WIDTH = 860;
const LAYER_CENTER_X = LAYER_X + LAYER_WIDTH / 2;
const CHIP_WIDTH = 256;
const CHIP_COLUMN_STEP = 272;
const CHIP_ROW_STEP = 88;
const BUS_X = 924;
const EXTERNAL_X = 948;
const CLIENT_Y = 90;
const EDGE_Y = 764;
const STORAGE_Y = 1082;
const BROWSER_SERVICES_Y = 98;
const BROWSER_SERVICES_STEP = 118;
const WORKER_SERVICES_Y = 774;
const WORKER_SERVICES_STEP = 108;
// WebRTC media runs straight from the client to the SFU, the last worker service.
const MEDIA_PATH_Y = 640;
const MEDIA_PATH_X = 1300;
const SFU_CONNECTOR_Y =
  WORKER_SERVICES_Y + (workerServices.length - 1) * WORKER_SERVICES_STEP + EXTERNAL_BOX_HEIGHT / 2;

function chipX(index: number) {
  return LAYER_X + 24 + (index % 3) * CHIP_COLUMN_STEP;
}

function chipY(layerY: number, index: number) {
  return layerY + 70 + Math.floor(index / 3) * CHIP_ROW_STEP;
}

interface LayerProps {
  y: number;
  height: number;
  title: string;
  subtitle: string;
  chips: ChipSpec[];
}

function Layer({ y, height, title, subtitle, chips }: LayerProps) {
  return (
    <g>
      <rect
        x={LAYER_X}
        y={y}
        width={LAYER_WIDTH}
        height={height}
        rx={6}
        fill="var(--paper-strong)"
        stroke="var(--blue)"
        strokeWidth={1.4}
      />
      <text
        x={LAYER_X + 24}
        y={y + 30}
        fontFamily="var(--font-mono)"
        fontWeight={500}
        fontSize={15}
        fill="var(--ink)"
      >
        {title}
      </text>
      <text x={LAYER_X + 24} y={y + 49} fontSize={12} fill="var(--ink-soft)">
        {subtitle}
      </text>
      {chips.map((chip, i) => (
        <Chip key={chip.title} x={chipX(i)} y={chipY(y, i)} width={CHIP_WIDTH} {...chip} />
      ))}
    </g>
  );
}

function layerHeight(chipCount: number) {
  return 70 + Math.ceil(chipCount / 3) * CHIP_ROW_STEP + 16;
}

interface FlowArrowProps {
  fromY: number;
  toY: number;
  label: string;
}

function FlowArrow({ fromY, toY, label }: FlowArrowProps) {
  return (
    <g>
      <line
        x1={LAYER_CENTER_X}
        y1={fromY}
        x2={LAYER_CENTER_X}
        y2={toY - 8}
        stroke="var(--ink-soft)"
        strokeWidth={1.4}
        markerEnd="url(#arch-arrow)"
      />
      <text
        x={LAYER_CENTER_X + 12}
        y={(fromY + toY) / 2 + 4}
        fontFamily="var(--font-mono)"
        fontSize={11}
        fill="var(--ink-faint)"
      >
        {label}
      </text>
    </g>
  );
}

interface ServiceGroupProps {
  y: number;
  step: number;
  caption: string;
  services: ExternalSpec[];
}

// A column of external services fed from the layer on their left: the first
// box's connector starts at the layer's edge, and the rest branch off a
// vertical bus that runs down to the last box.
function ServiceGroup({ y, step, caption, services }: ServiceGroupProps) {
  const firstConnectorY = y + EXTERNAL_BOX_HEIGHT / 2;
  const lastConnectorY = firstConnectorY + (services.length - 1) * step;
  return (
    <g>
      <text
        x={EXTERNAL_X}
        y={y - 10}
        fontFamily="var(--font-mono)"
        fontSize={11}
        fill="var(--ink-faint)"
      >
        {caption}
      </text>
      <line
        x1={BUS_X}
        y1={firstConnectorY}
        x2={BUS_X}
        y2={lastConnectorY}
        stroke="var(--dashline)"
        strokeWidth={1.4}
        strokeDasharray="4 4"
      />
      {services.map((service, i) => (
        <ExternalBox
          key={service.title}
          x={EXTERNAL_X}
          y={y + i * step}
          connectorStartX={i === 0 ? undefined : BUS_X}
          {...service}
        />
      ))}
    </g>
  );
}

const CLIENT_HEIGHT = layerHeight(clientChips.length);
const EDGE_HEIGHT = layerHeight(edgeChips.length);
const STORAGE_HEIGHT = layerHeight(storageChips.length);
const VIEW_HEIGHT = WORKER_SERVICES_Y + workerServices.length * WORKER_SERVICES_STEP + 12;

export default function ArchitecturePage() {
  useDocumentTitle("next-editor — system architecture");

  return (
    <div className="arch-page">
      <style>{styles}</style>
      <div className="page-inner">
        <div className="sheet">
          <div className="titleblock">
            <div>
              <h1>next-editor — system architecture</h1>
              <p className="sub">
                Browser editor that records and replays coding lessons — live runtimes, slides, a
                whiteboard, a coding agent, rooms with voice chat, and a lesson studio — served by
                one Cloudflare Worker.
              </p>
            </div>
            <div className="meta">
              <div>
                <b>sheet</b>
                <span>01 / 01</span>
              </div>
              <div>
                <b>scale</b>
                <span>nts</span>
              </div>
              <div>
                <b>rev</b>
                <span>F</span>
              </div>
              <div>
                <b>date</b>
                <span>2026-10-08</span>
              </div>
            </div>
          </div>

          {/* The diagram scrolls sideways on narrow screens; Safari does not
              focus scroll containers on its own, so the wrapper takes focus
              to let keyboard users scroll it with the arrow keys. */}
          <div
            className="diagram-wrap"
            role="region"
            tabIndex={0}
            aria-label="System architecture diagram"
          >
            <svg
              viewBox={`0 0 1320 ${VIEW_HEIGHT}`}
              width="100%"
              role="img"
              xmlns="http://www.w3.org/2000/svg"
            >
              <title>
                Layered architecture: browser client, Cloudflare Worker edge, storage and state
                bindings, and the external services each layer calls
              </title>
              <desc>
                The browser runs the single-page app — editor, runtimes, recorder, player, Studio,
                and collaboration clients — and loads the WebContainer runtime from StackBlitz,
                published decks from Google Slides, model weights from Hugging Face, and sends
                analytics to PostHog. It reaches one Cloudflare Worker over HTTPS and WebSockets.
                The Worker serves the static build with edge rendering, authenticates users, and
                proxies the language playgrounds and the coding agent's model calls. It uses D1, R2,
                Workers KV, room and voice Durable Objects, and rate-limit bindings, and calls
                Google Identity, the language playgrounds, OpenRouter, AthanLab (Burmese narration
                with each user's own encrypted key), Modal, and Upstash QStash. The voice Durable
                Objects gate every call to the Cloudflare Realtime SFU, which exchanges audio-only
                WebRTC media directly with the browser.
              </desc>

              <defs>
                <pattern id="arch-grid" width={28} height={28} patternUnits="userSpaceOnUse">
                  <path
                    d="M 28 0 L 0 0 0 28"
                    fill="none"
                    stroke="var(--grid-line)"
                    strokeWidth={1}
                    opacity={0.55}
                  />
                </pattern>
                <marker
                  id="arch-arrow"
                  viewBox="0 0 10 10"
                  refX={8}
                  refY={5}
                  markerWidth={7}
                  markerHeight={7}
                  orient="auto-start-reverse"
                >
                  <path
                    d="M2 1L8 5L2 9"
                    fill="none"
                    stroke="var(--ink-soft)"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </marker>
                <marker
                  id="arch-arrow-dash"
                  viewBox="0 0 10 10"
                  refX={8}
                  refY={5}
                  markerWidth={7}
                  markerHeight={7}
                  orient="auto-start-reverse"
                >
                  <path
                    d="M2 1L8 5L2 9"
                    fill="none"
                    stroke="var(--dashline)"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </marker>
              </defs>

              <rect x={0} y={0} width={1320} height={VIEW_HEIGHT} fill="url(#arch-grid)" />

              <rect
                x={LAYER_CENTER_X - 80}
                y={14}
                width={160}
                height={34}
                rx={17}
                fill="none"
                stroke="var(--ink-soft)"
                strokeWidth={1.2}
              />
              <text
                x={LAYER_CENTER_X}
                y={31}
                textAnchor="middle"
                dominantBaseline="central"
                fontFamily="var(--font-mono)"
                fontSize={12}
                fill="var(--ink-soft)"
              >
                end user
              </text>
              <FlowArrow fromY={48} toY={CLIENT_Y} label="loads app" />

              <Layer
                y={CLIENT_Y}
                height={CLIENT_HEIGHT}
                title="CLIENT — browser"
                subtitle="React 19 single-page app · editor, runtimes, recorder, player, studio"
                chips={clientChips}
              />

              <FlowArrow
                fromY={CLIENT_Y + CLIENT_HEIGHT}
                toY={EDGE_Y}
                label="https · /api · /media · websockets"
              />

              <Layer
                y={EDGE_Y}
                height={EDGE_HEIGHT}
                title="EDGE — cloudflare worker"
                subtitle="one Hono Worker for every request to nexteditor.dev"
                chips={edgeChips}
              />

              <FlowArrow
                fromY={EDGE_Y + EDGE_HEIGHT}
                toY={STORAGE_Y}
                label="reads / writes · durable object stubs"
              />

              <Layer
                y={STORAGE_Y}
                height={STORAGE_HEIGHT}
                title="STORAGE & STATE"
                subtitle="cloudflare-managed bindings"
                chips={storageChips}
              />

              <ServiceGroup
                y={BROWSER_SERVICES_Y}
                step={BROWSER_SERVICES_STEP}
                caption="called from the browser"
                services={browserServices}
              />

              <ServiceGroup
                y={WORKER_SERVICES_Y}
                step={WORKER_SERVICES_STEP}
                caption="called from the worker"
                services={workerServices}
              />

              <path
                d={`M${LAYER_X + LAYER_WIDTH} ${MEDIA_PATH_Y} H${MEDIA_PATH_X} V${SFU_CONNECTOR_Y} H${EXTERNAL_X + 336}`}
                fill="none"
                stroke="var(--dashline)"
                strokeWidth={1.4}
                strokeDasharray="5 4"
                markerEnd="url(#arch-arrow-dash)"
              />
              <text
                x={EXTERNAL_X + 16}
                y={MEDIA_PATH_Y - 8}
                fontFamily="var(--font-mono)"
                fontSize={11}
                fill="var(--ink-faint)"
              >
                webrtc audio · dtls-srtp → SFU
              </text>
            </svg>
          </div>

          <div className="legend">
            <div className="legend-item">
              <span className="swatch solid" /> cloudflare-owned binding
            </div>
            <div className="legend-item">
              <span className="swatch dash" /> external service
            </div>
            <div className="legend-item">
              <span className="swatch arrow" /> data flow
            </div>
            <div className="legend-item">
              <span className="swatch arrow dashed" /> external call
            </div>
            <div className="legend-item">
              <span className="tagdot">#</span> see note
            </div>
          </div>

          <div className="notes">
            <h2>Notes</h2>
            <div className="notes-grid">
              {notes.map((note) => (
                <div className="note" key={note.n}>
                  <span className="n">{note.n}</span>
                  <span>
                    <b>{note.title} —</b> <span className="d">{note.detail}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="build">
            <h2>Build &amp; tooling</h2>
            <table className="spec-table">
              <tbody>
                <tr>
                  <td>package manager</td>
                  <td>
                    <code>bun</code>
                  </td>
                </tr>
                <tr>
                  <td>toolchain</td>
                  <td>
                    <code>vite 8</code>
                    <code>rolldown</code>
                    <code>oxc</code>
                    <code>vitest</code>
                    <code>oxlint</code>
                    <code>oxfmt</code>{" "}
                    <span className="note-inline">
                      — bundled by Vite+ behind the <code>vp</code> cli
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>compiler</td>
                  <td>
                    <code>react compiler</code>{" "}
                    <span className="note-inline">
                      babel preset on rolldown, no manual memoization; @babel/core held at 7.x
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>styling</td>
                  <td>
                    <code>tailwind css 4</code>
                  </td>
                </tr>
                <tr>
                  <td>wasm</td>
                  <td>
                    <code>rust</code>
                    <code>wasm32-unknown-unknown</code>
                    <code>wasm-opt</code>{" "}
                    <span className="note-inline">
                      — ~7KB diff codec built here; the ~2.2MB kitec build is vendored; both
                      committed
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>types</td>
                  <td>
                    <code>typescript 7</code>{" "}
                    <span className="note-inline">
                      native compiler; <code>bun run typecheck</code> checks the app and the Worker
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>collaboration</td>
                  <td>
                    <code>yjs</code>
                    <code>durable objects + sqlite</code>{" "}
                    <span className="note-inline">
                      — authenticated binary WebSockets with per-room durability
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>voice chat</td>
                  <td>
                    <code>partytracks 0.0.56</code>
                    <code>cloudflare realtime sfu</code>{" "}
                    <span className="note-inline">
                      — audio-only WebRTC behind a capability-checked room gateway; feature-flagged
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>public cache</td>
                  <td>
                    <code>workers kv</code>{" "}
                    <span className="note-inline">
                      — fail-open lesson, playlist, and playground-result cache
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>tests</td>
                  <td>
                    <code>vitest</code>
                    <code>fast-check</code>{" "}
                    <span className="note-inline">
                      run via <code>vp test</code> in jsdom; the Worker has its own node config;
                      fast-check property tests check the replay, recording-clock, and media-span
                      laws over generated inputs
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>observability</td>
                  <td>
                    <code>posthog</code>
                    <code>workers logs + traces</code>{" "}
                    <span className="note-inline">
                      edge request logs carry X-POSTHOG-* headers to cross-link sessions
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>deploy</td>
                  <td>
                    <code>wrangler</code>{" "}
                    <span className="note-inline">
                      bun run build → wrangler deploy --config infra/wrangler.toml · nexteditor.dev
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
