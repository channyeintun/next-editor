import {
  API_CLIENT_READY_MESSAGE_TYPE,
  API_CLIENT_REQUEST_MESSAGE_TYPE,
  API_CLIENT_RESPONSE_MESSAGE_TYPE,
} from "../../utils/apiClientBridge";
import { createRrwebPreviewRecorderScript } from "./rrwebPreview";
// The API client app, shipped as a plain-JS asset so it runs verbatim inside the
// iframe realm (no bundler/TS/module scope). See apiClientRuntime.js.
import apiClientRuntime from "./apiClientRuntime.js?raw";

const API_CLIENT_RRWEB_SETUP_MARKER = "__NEXT_EDITOR_API_CLIENT_RRWEB__";

const API_CLIENT_STYLES = `
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #1a1e27;
    color: #e2e8f0;
    font-size: 13px;
  }
  #app { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
  .banner {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 12px;
    background: rgba(245, 158, 11, 0.1);
    color: #fcd34d;
    font-size: 11px;
    border-bottom: 1px solid #1e293b;
  }
  .reqline {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid #1e293b;
  }
  select, input, textarea, button { font: inherit; color: inherit; }
  #method {
    height: 32px; padding: 0 8px;
    background: #242938; border: 1px solid #334155; border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; font-weight: 700;
  }
  .m-GET { color: #34d399; } .m-POST { color: #fbbf24; } .m-PUT { color: #60a5fa; }
  .m-PATCH { color: #c084fc; } .m-DELETE { color: #f87171; }
  #path {
    flex: 1; min-width: 0; height: 32px; padding: 0 10px;
    background: #242938; border: 1px solid #334155; border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  }
  #path::placeholder { color: #475569; }
  #path:focus, #method:focus, textarea:focus, .hdr-key:focus, .hdr-val:focus {
    outline: none; border-color: #0ea5e9; box-shadow: 0 0 0 1px #0ea5e9;
  }
  #send {
    height: 32px; padding: 0 14px;
    background: #0284c7; border: none; border-radius: 6px;
    color: #fff; font-weight: 600; cursor: pointer;
  }
  #send:hover { background: #0ea5e9; }
  #send:disabled { opacity: 0.5; cursor: not-allowed; }
  .tabs { display: flex; gap: 4px; padding: 0 12px; border-bottom: 1px solid #1e293b; }
  .tab {
    padding: 8px 12px; background: none; border: none;
    border-bottom: 2px solid transparent; color: #64748b;
    font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .tab.active { color: #38bdf8; border-bottom-color: #38bdf8; }
  .tabpanel { border-bottom: 1px solid #1e293b; }
  #headers-list { padding: 8px 12px 0; max-height: 140px; overflow-y: auto; }
  .hdr-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .hdr-key { width: 33%; }
  .hdr-val { flex: 1; min-width: 0; }
  .hdr-key, .hdr-val {
    height: 28px; padding: 0 8px;
    background: #242938; border: 1px solid #334155; border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  }
  .hdr-remove {
    background: none; border: none; color: #64748b; cursor: pointer; font-size: 16px;
  }
  .hdr-remove:hover { color: #f87171; }
  #add-header {
    margin: 4px 12px 10px; padding: 4px 8px;
    background: none; border: none; color: #64748b; cursor: pointer; font-size: 11px;
  }
  #add-header:hover { color: #cbd5e1; }
  #body {
    width: 100%; height: 130px; resize: none; padding: 8px 12px;
    background: #151820; border: none; color: #e2e8f0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  }
  #response { flex: 1; min-height: 0; overflow: auto; }
  .resp-empty { display: flex; height: 100%; align-items: center; justify-content: center; color: #475569; }
  .resp-error { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 24px; text-align: center; }
  .resp-msg { color: #cbd5e1; font-size: 12px; }
  .resp-status {
    display: flex; align-items: center; gap: 12px;
    padding: 6px 12px; border-bottom: 1px solid #1e293b;
  }
  .resp-meta { color: #64748b; font-size: 11px; }
  .resp-hbtn { margin-left: auto; background: none; border: none; color: #64748b; cursor: pointer; font-size: 11px; }
  .resp-hbtn:hover { color: #cbd5e1; }
  .resp-headers { padding: 6px 12px; background: #151820; border-bottom: 1px solid #1e293b; }
  .rhdr { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .rhdr-k { color: #94a3b8; font-weight: 600; } .rhdr-v { color: #64748b; word-break: break-all; }
  .resp-body {
    margin: 0; padding: 10px 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    white-space: pre-wrap; word-break: break-word;
  }
  .resp-body .key { color: #7dd3fc; }
  .resp-body .str { color: #86efac; }
  .resp-body .num { color: #fbbf24; }
  .resp-body .bool { color: #c4b5fd; }
  .resp-body .null { color: #94a3b8; }
  .badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
  .badge.ok { background: rgba(16, 185, 129, 0.2); color: #6ee7b7; }
  .badge.redir { background: rgba(245, 158, 11, 0.2); color: #fcd34d; }
  .badge.err { background: rgba(239, 68, 68, 0.2); color: #fca5a5; }
  .history { border-top: 1px solid #1e293b; }
  .history-head { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; }
  .history-title { color: #64748b; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  #clear-history { background: none; border: none; color: #475569; cursor: pointer; font-size: 11px; }
  #clear-history:hover { color: #94a3b8; }
  #history-list { max-height: 112px; overflow-y: auto; padding: 0 4px 6px; }
  .hist-item {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 4px 8px; background: none; border: none; border-radius: 6px;
    color: inherit; text-align: left; cursor: pointer;
  }
  .hist-item:hover { background: #1e293b; }
  .hist-method { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 700; }
  .hist-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #94a3b8; }
`;

const API_CLIENT_BODY = `
  <div id="banner" class="banner">⏳ Waiting for the server to start…</div>
  <div id="app">
    <div class="reqline">
      <select id="method">
        <option value="GET">GET</option>
        <option value="POST">POST</option>
        <option value="PUT">PUT</option>
        <option value="PATCH">PATCH</option>
        <option value="DELETE">DELETE</option>
      </select>
      <input id="path" type="text" placeholder="/api/endpoint" value="/" aria-label="Request path" />
      <button id="send" type="button" disabled>Send</button>
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="headers" type="button">Headers</button>
      <button class="tab" data-tab="body" type="button" hidden>Body</button>
    </div>
    <div id="headers-panel" class="tabpanel">
      <div id="headers-list"></div>
      <button id="add-header" type="button">+ Add header</button>
    </div>
    <div id="body-panel" class="tabpanel" hidden>
      <textarea id="body" placeholder='{ "key": "value" }' spellcheck="false"></textarea>
    </div>
    <div id="response"><div class="resp-empty">Send a request to see the response</div></div>
    <div id="history" class="history" hidden>
      <div class="history-head">
        <span class="history-title">History</span>
        <button id="clear-history" type="button">Clear</button>
      </div>
      <div id="history-list"></div>
    </div>
  </div>
`;

/**
 * Builds the full HTML document for the API-client iframe (`srcdoc`). The app runs
 * verbatim from `apiClientRuntime.js`, and the rrweb recorder is injected alongside
 * it so the whole interaction is recorded/replayed by the existing preview pipeline.
 */
export function createApiClientDocument(): string {
  const config = JSON.stringify({
    requestType: API_CLIENT_REQUEST_MESSAGE_TYPE,
    responseType: API_CLIENT_RESPONSE_MESSAGE_TYPE,
    readyType: API_CLIENT_READY_MESSAGE_TYPE,
  });
  const recorder = createRrwebPreviewRecorderScript({
    setupMarker: API_CLIENT_RRWEB_SETUP_MARKER,
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${API_CLIENT_STYLES}</style>
</head>
<body>
${API_CLIENT_BODY}
<script>window.__API_CLIENT_CONFIG__ = ${config};</script>
<script>${apiClientRuntime}</script>
<script>${recorder}</script>
</body>
</html>`;
}
