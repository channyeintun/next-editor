import { Link } from "react-router";

// The engineering-drawing sheet the architecture pages are drawn on: its paper,
// ink and grid, the title block, the legend, the notes and the spec table. A
// page adds only the styles of what it alone draws.
export const architectureSheetStyles = `
.arch-page{
  --arch-page-bg:#e4e9ee;
  --paper:#eef2f6; --paper-strong:#e2e9f1; --grid-line:#c9d6e3;
  --ink:#14243a; --ink-soft:#384a62; --ink-faint:#56687f;
  --blue:#2f6fa8; --blue-fill:#dce7f0;
  --redline:#8a271d; --redline-fill:#f6e3e0;
  --dashline:#5f7790;
  --font-mono: ui-monospace,"SF Mono","Cascadia Code","JetBrains Mono",Menlo,Consolas,monospace;
  --font-sans: -apple-system,"Segoe UI",system-ui,"Helvetica Neue",Arial,sans-serif;
}
@media (prefers-color-scheme: dark){
  .arch-page{
    --arch-page-bg:#081a30;
    --paper:#0d2542; --paper-strong:#123055; --grid-line:#1f4870;
    --ink:#eaf3fb; --ink-soft:#b1cee8; --ink-faint:#6f93b8;
    --blue:#7fb3d9; --blue-fill:#163a5c;
    --redline:#ffa58f; --redline-fill:#4a2420;
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
.arch-page a:focus-visible, .arch-page button:focus-visible, .arch-page [tabindex]:focus-visible{
  outline:2px solid var(--blue); outline-offset:2px;
}
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
.arch-page .sheet-nav{
  display:flex; flex-wrap:wrap; gap:4px 24px; align-items:baseline;
  padding:10px 32px; border-bottom:1px solid var(--grid-line);
  font-family:var(--font-mono); font-size:12px; color:var(--ink-faint);
}
.arch-page .sheet-nav a{ color:var(--blue); text-decoration:underline; text-underline-offset:3px; }
.arch-page .sheet-nav [aria-current="page"]{ color:var(--ink); font-weight:500; }
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
.arch-page .sheet h2{
  font-family:var(--font-mono); font-size:13px; font-weight:500; letter-spacing:.04em;
  text-transform:uppercase; color:var(--ink-soft); margin:0 0 14px;
}
.arch-page .notes-grid{ display:grid; grid-template-columns:repeat(2,1fr); gap:8px 32px; margin:0; padding:0; list-style:none; }
.arch-page .note{ display:flex; gap:10px; font-size:13px; line-height:1.5; align-items:baseline; }
.arch-page .note .n{ font-family:var(--font-mono); color:var(--redline); font-size:12px; flex:none; width:1.4em; }
.arch-page .note b{ font-weight:500; color:var(--ink); }
.arch-page .note .d{ color:var(--ink-soft); }
.arch-page .build{ padding:8px 32px 32px; }
.arch-page .build h2{ margin-top:24px; }
.arch-page .spec-table{ width:100%; border-collapse:collapse; font-size:13px; }
.arch-page .spec-table tr{ border-bottom:1px solid var(--grid-line); }
.arch-page .spec-table tr:last-child{ border-bottom:none; }
.arch-page .spec-table th, .arch-page .spec-table td{ padding:9px 14px 9px 0; vertical-align:top; }
.arch-page .spec-table th{
  font-family:var(--font-mono); color:var(--ink-soft); font-size:11px; font-weight:400; text-align:left;
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
  .arch-page .sheet-nav{ padding-left:18px; padding-right:18px; }
  .arch-page .diagram-wrap{ padding:8px 8px 4px; }
  .arch-page .notes, .arch-page .build{ padding-left:18px; padding-right:18px; }
}
`;

/** The sheets of the set, in order: a sheet's number is its place here. */
const ARCHITECTURE_SHEETS = [
  { id: "system", label: "system architecture", to: "/architecture" },
  { id: "webnode", label: "webnode runtime", to: "/architecture/webnode" },
] as const;

export type ArchitectureSheetId = (typeof ARCHITECTURE_SHEETS)[number]["id"];

const twoDigits = (value: number) => String(value).padStart(2, "0");

/** A sheet's place in the set, as its title block writes it: "02 / 02". */
export function architectureSheetNumber(id: ArchitectureSheetId): string {
  const index = ARCHITECTURE_SHEETS.findIndex((sheet) => sheet.id === id);
  return `${twoDigits(index + 1)} / ${twoDigits(ARCHITECTURE_SHEETS.length)}`;
}

/** The row under a title block that leads to the other sheets. */
export function ArchitectureSheetNav({ current }: { current: ArchitectureSheetId }) {
  return (
    <nav className="sheet-nav" aria-label="Architecture sheets">
      {ARCHITECTURE_SHEETS.map((sheet, index) => {
        const name = `${twoDigits(index + 1)} ${sheet.label}`;
        return sheet.id === current ? (
          <span key={sheet.id} aria-current="page">
            {name}
          </span>
        ) : (
          <Link key={sheet.id} to={sheet.to}>
            {name}
          </Link>
        );
      })}
    </nav>
  );
}
