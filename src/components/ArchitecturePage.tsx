import { useEffect } from "react";

const styles = `
.arch-page{
  --arch-page-bg:#e4e9ee;
  --paper:#eef2f6; --paper-strong:#e2e9f1; --grid-line:#c9d6e3;
  --ink:#14243a; --ink-soft:#4a5d75; --ink-faint:#7c8ea4;
  --blue:#2f6fa8; --blue-fill:#dce7f0;
  --redline:#b23a2e; --redline-fill:#f6e3e0;
  --dashline:#7c93ab;
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

interface ExternalBoxProps {
  x: number;
  y: number;
  title: string;
  lines: string[];
  tag: number;
}

function ExternalBox({ x, y, title, lines, tag }: ExternalBoxProps) {
  return (
    <g>
      <line
        x1={x - 48}
        y1={y + 52}
        x2={x - 4}
        y2={y + 52}
        stroke="var(--dashline)"
        strokeWidth={1.4}
        strokeDasharray="4 4"
        markerEnd="url(#arch-arrow-dash)"
      />
      <rect
        x={x}
        y={y}
        width={332}
        height={104}
        rx={6}
        fill="none"
        stroke="var(--dashline)"
        strokeWidth={1.4}
        strokeDasharray="5 4"
      />
      <text
        x={x + 22}
        y={y + 30}
        fontFamily="var(--font-mono)"
        fontSize={13}
        fontWeight={500}
        fill="var(--ink)"
      >
        {title}
      </text>
      {lines.map((line, i) => (
        <text key={line} x={x + 22} y={y + 48 + i * 18} fontSize={11.5} fill="var(--ink-soft)">
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

const clientChips: Array<Omit<ChipProps, "x" | "y" | "width">> = [
  { title: "React 19 + Compiler", lines: ["app shell, no manual memo"], tag: 1 },
  { title: "Monaco editor", lines: ["code editing surface"], tag: 2 },
  { title: "Excalidraw", lines: ["whiteboard, delta capture"], tag: 3 },
  { title: "xstate · store-react", lines: ["recorder machine + app stores"], tag: 4 },
  { title: "WebContainer", lines: ["in-browser dev server runtime"], tag: 5 },
  { title: "sandboxed iframe", lines: ["live preview, postMessage bridge"], tag: 6 },
  { title: "rrweb recorder", lines: ["DOM capture + corrective snapshots"], tag: 7 },
  { title: "dmp (Rust→WASM) + fflate", lines: ["delta codec for the SCR3 stream"], tag: 8 },
  { title: "xterm.js", lines: ["in-browser terminal"], tag: 9 },
];

const notes: Array<{ n: string; title: string; detail: string }> = [
  {
    n: "01",
    title: "React 19 + Compiler",
    detail: "app shell; compiler auto-memoizes, no manual useCallback/useMemo.",
  },
  { n: "02", title: "Monaco editor", detail: "the code editing surface." },
  {
    n: "03",
    title: "Excalidraw",
    detail: "whiteboard; records element upserts/removals as deltas, not full snapshots.",
  },
  {
    n: "04",
    title: "xstate + store-react",
    detail: "recorder state machine plus lightweight app-level stores.",
  },
  {
    n: "05",
    title: "WebContainer",
    detail: "boots an isolated Node dev server entirely in the browser.",
  },
  {
    n: "06",
    title: "Sandboxed iframe",
    detail: "runs the live preview; host and preview talk over postMessage.",
  },
  {
    n: "07",
    title: "rrweb recorder",
    detail: "captures DOM/input; takes corrective full snapshots when mutations drift.",
  },
  {
    n: "08",
    title: "dmp + fflate",
    detail:
      "Rust-to-WASM diff-match-patch codec, deflate-compressed, packed into the SCR3 stream format.",
  },
  { n: "09", title: "xterm.js", detail: "terminal emulator for the WebContainer shell." },
  {
    n: "10",
    title: "Hono API routes",
    detail: "lessons, playlists, authors, search, auth, uploads.",
  },
  {
    n: "11",
    title: "Static assets",
    detail: "Cloudflare Static Assets binding serves the built client.",
  },
  {
    n: "12",
    title: "/api/proxy",
    detail: "fetch proxy for the preview; blocks loopback/private hosts.",
  },
  {
    n: "13",
    title: "Google OAuth 2.0",
    detail: "sign-in; edge issues its own session cookie afterward.",
  },
  { n: "14", title: "D1", detail: "SQLite at the edge; relational data for accounts and content." },
  {
    n: "15",
    title: "R2",
    detail: "object storage for editor state and recorded media, up to 200MB/upload.",
  },
  {
    n: "16",
    title: "Upstash Redis",
    detail: "read-through cache; app degrades gracefully if unset.",
  },
];

export default function ArchitecturePage() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "next-editor — system architecture";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <div className="arch-page">
      <style>{styles}</style>
      <div className="page-inner">
        <div className="sheet">
          <div className="titleblock">
            <div>
              <h1>next-editor — system architecture</h1>
              <p className="sub">
                Browser-based code editor with live preview, session recording and a whiteboard,
                running on Cloudflare's edge.
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
                <span>—</span>
              </div>
              <div>
                <b>date</b>
                <span>2026-07-11</span>
              </div>
            </div>
          </div>

          <div className="diagram-wrap">
            <svg viewBox="0 0 1320 950" width="100%" role="img" xmlns="http://www.w3.org/2000/svg">
              <title>Layered architecture: browser client, Cloudflare edge, storage</title>
              <desc>
                User's browser runs the client app and connects over HTTPS to a Cloudflare Worker
                edge, which talks to Google OAuth externally and reads/writes Cloudflare D1, R2 and
                an optional external Redis cache.
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

              <rect x={0} y={0} width={1320} height={950} fill="url(#arch-grid)" />

              <rect
                x={580}
                y={14}
                width={160}
                height={34}
                rx={17}
                fill="none"
                stroke="var(--ink-soft)"
                strokeWidth={1.2}
              />
              <text
                x={660}
                y={31}
                textAnchor="middle"
                dominantBaseline="central"
                fontFamily="var(--font-mono)"
                fontSize={12}
                fill="var(--ink-soft)"
              >
                end user
              </text>
              <line
                x1={660}
                y1={48}
                x2={660}
                y2={86}
                stroke="var(--ink-soft)"
                strokeWidth={1.4}
                markerEnd="url(#arch-arrow)"
              />
              <text
                x={672}
                y={70}
                fontFamily="var(--font-mono)"
                fontSize={11}
                fill="var(--ink-faint)"
              >
                loads app
              </text>

              <rect
                x={40}
                y={90}
                width={1240}
                height={380}
                rx={6}
                fill="var(--paper-strong)"
                stroke="var(--blue)"
                strokeWidth={1.4}
              />
              <text
                x={64}
                y={120}
                fontFamily="var(--font-mono)"
                fontWeight={500}
                fontSize={15}
                fill="var(--ink)"
              >
                CLIENT — browser
              </text>
              <text x={64} y={139} fontSize={12} fill="var(--ink-soft)">
                React 19 single-page app · editor runtime · session recorder
              </text>

              {clientChips.map((chip, i) => (
                <Chip
                  key={chip.title}
                  x={64 + (i % 3) * 396}
                  y={160 + Math.floor(i / 3) * 88}
                  width={380}
                  {...chip}
                />
              ))}

              <line
                x1={660}
                y1={470}
                x2={660}
                y2={522}
                stroke="var(--ink-soft)"
                strokeWidth={1.4}
                markerEnd="url(#arch-arrow)"
              />
              <text
                x={672}
                y={500}
                fontFamily="var(--font-mono)"
                fontSize={11}
                fill="var(--ink-faint)"
              >
                https · /api (hono)
              </text>

              <rect
                x={40}
                y={530}
                width={860}
                height={168}
                rx={6}
                fill="var(--paper-strong)"
                stroke="var(--blue)"
                strokeWidth={1.4}
              />
              <text
                x={64}
                y={558}
                fontFamily="var(--font-mono)"
                fontWeight={500}
                fontSize={15}
                fill="var(--ink)"
              >
                EDGE — cloudflare worker
              </text>
              <text x={64} y={577} fontSize={12} fill="var(--ink-soft)">
                request handling at the edge
              </text>

              <Chip
                x={64}
                y={596}
                width={256}
                title="Hono API routes"
                lines={["lessons, playlists,", "authors, search, uploads"]}
                tag={10}
              />
              <Chip
                x={336}
                y={596}
                width={256}
                title="static assets"
                lines={["serves built dist/ via", "ASSETS binding"]}
                tag={11}
              />
              <Chip
                x={608}
                y={596}
                width={256}
                title="/api/proxy"
                lines={["SSRF-guarded fetch,", "blocks private hosts"]}
                tag={12}
              />

              <ExternalBox
                x={948}
                y={562}
                title="Google OAuth 2.0"
                lines={["external identity provider", "session cookie issued by edge"]}
                tag={13}
              />

              <line
                x1={470}
                y1={698}
                x2={470}
                y2={750}
                stroke="var(--ink-soft)"
                strokeWidth={1.4}
                markerEnd="url(#arch-arrow)"
              />
              <text
                x={482}
                y={728}
                fontFamily="var(--font-mono)"
                fontSize={11}
                fill="var(--ink-faint)"
              >
                reads / writes
              </text>

              <rect
                x={40}
                y={758}
                width={860}
                height={168}
                rx={6}
                fill="var(--paper-strong)"
                stroke="var(--blue)"
                strokeWidth={1.4}
              />
              <text
                x={64}
                y={786}
                fontFamily="var(--font-mono)"
                fontWeight={500}
                fontSize={15}
                fill="var(--ink)"
              >
                STORAGE
              </text>
              <text x={64} y={805} fontSize={12} fill="var(--ink-soft)">
                cloudflare-managed data
              </text>

              <Chip
                x={64}
                y={824}
                width={398}
                title="D1 (SQLite)"
                lines={["users, sessions, lessons,", "playlists, playlist_lessons"]}
                tag={14}
              />
              <Chip
                x={480}
                y={824}
                width={384}
                title="R2 (object storage)"
                lines={[".ne files, audio/video,", "thumbnails · served /media/:key"]}
                tag={15}
              />

              <ExternalBox
                x={948}
                y={790}
                title="Upstash Redis"
                lines={["optional cache layer", "lesson/playlist reads, ttl 1–5 min"]}
                tag={16}
              />
            </svg>
          </div>

          <div className="legend">
            <div className="legend-item">
              <span className="swatch solid" /> cloudflare-owned binding
            </div>
            <div className="legend-item">
              <span className="swatch dash" /> external / optional service
            </div>
            <div className="legend-item">
              <span className="swatch arrow" /> data flow
            </div>
            <div className="legend-item">
              <span className="swatch arrow dashed" /> external / optional call
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
                  <td>bundler</td>
                  <td>
                    <code>vite 8</code>
                    <code>rolldown</code>
                    <code>oxc</code>{" "}
                    <span className="note-inline">
                      — wrapped by the <code>vp</code> cli
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>compiler</td>
                  <td>
                    <code>react compiler</code>{" "}
                    <span className="note-inline">via babel plugin, no manual memoization</span>
                  </td>
                </tr>
                <tr>
                  <td>styling</td>
                  <td>
                    <code>tailwind css 4</code>
                  </td>
                </tr>
                <tr>
                  <td>wasm pipeline</td>
                  <td>
                    <code>rust</code>
                    <code>wasm32-unknown-unknown</code>
                    <code>wasm-opt</code>{" "}
                    <span className="note-inline">— ~7KB codec, committed to the repo</span>
                  </td>
                </tr>
                <tr>
                  <td>types</td>
                  <td>
                    <code>typescript</code>{" "}
                    <span className="note-inline">
                      xstate pinned to 5.32.2 (tsgo regression in later patch)
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>tests</td>
                  <td>
                    <code>vitest</code>{" "}
                    <span className="note-inline">
                      run via <code>vp test</code>
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>deploy</td>
                  <td>
                    <code>wrangler</code>{" "}
                    <span className="note-inline">
                      vp build → npx wrangler deploy --config infra/wrangler.toml
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
