// Self-contained API client app that runs INSIDE the API-client srcdoc iframe.
//
// It is shipped as a plain-JS asset (imported `?raw` by apiClientDocument.ts and
// inlined into the iframe document) so it executes verbatim in the iframe realm —
// no bundler, no TypeScript, no module scope. It reads its protocol constants from
// `window.__API_CLIENT_CONFIG__`, which the document sets just before this runs.
//
// Everything it shows is plain DOM, so the rrweb recorder injected alongside it
// captures the whole interaction (typed URL, headers, body, rendered response) for
// replay — no live server is needed on playback.
(function () {
  var cfg = window.__API_CLIENT_CONFIG__ || {};
  var REQ = cfg.requestType;
  var RES = cfg.responseType;
  var READY = cfg.readyType;

  var state = {
    method: "GET",
    path: "/",
    headers: [],
    body: "",
    sending: false,
    ready: false,
    pendingId: null,
  };
  var idSeq = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function highlightJson(text) {
    var pretty;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return esc(text);
    }
    pretty = pretty.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return pretty.replace(
      /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      function (match) {
        var cls = "num";
        if (match.startsWith('"')) {
          cls = match.endsWith(":") ? "key" : "str";
        } else if (/true|false/.test(match)) {
          cls = "bool";
        } else if (/null/.test(match)) {
          cls = "null";
        }
        return '<span class="' + cls + '">' + match + "</span>";
      },
    );
  }

  function formatDuration(ms) {
    if (ms < 1000) {
      return Math.round(ms) + " ms";
    }
    return (ms / 1000).toFixed(2) + " s";
  }

  function formatSize(text) {
    var bytes = new Blob([text]).size;
    if (bytes < 1024) {
      return bytes + " B";
    }
    return (bytes / 1024).toFixed(1) + " KB";
  }

  function statusClass(status) {
    if (status < 300) return "ok";
    if (status < 400) return "redir";
    return "err";
  }

  // --- Headers ----------------------------------------------------------------

  function addHeaderRow(header) {
    var list = $("headers-list");
    var row = document.createElement("div");
    row.className = "hdr-row";

    var toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = header.enabled;
    toggle.addEventListener("change", function () {
      header.enabled = toggle.checked;
    });

    var key = document.createElement("input");
    key.type = "text";
    key.placeholder = "Header";
    key.className = "hdr-key";
    key.value = header.key;
    key.addEventListener("input", function () {
      header.key = key.value;
    });

    var val = document.createElement("input");
    val.type = "text";
    val.placeholder = "Value";
    val.className = "hdr-val";
    val.value = header.value;
    val.addEventListener("input", function () {
      header.value = val.value;
    });

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "hdr-remove";
    remove.textContent = "−";
    remove.addEventListener("click", function () {
      var index = state.headers.indexOf(header);
      if (index >= 0) {
        state.headers.splice(index, 1);
      }
      list.removeChild(row);
      updateTabLabels();
    });

    row.appendChild(toggle);
    row.appendChild(key);
    row.appendChild(val);
    row.appendChild(remove);
    list.appendChild(row);
  }

  function updateTabLabels() {
    var headerTab = document.querySelector('.tab[data-tab="headers"]');
    if (headerTab) {
      headerTab.textContent =
        state.headers.length > 0 ? "Headers (" + state.headers.length + ")" : "Headers";
    }
  }

  // --- Tabs -------------------------------------------------------------------

  function setTab(tab) {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      var isActive = tabs[i].getAttribute("data-tab") === tab;
      tabs[i].className = isActive ? "tab active" : "tab";
    }
    $("headers-panel").hidden = tab !== "headers";
    $("body-panel").hidden = tab !== "body";
  }

  function updateBodyTabVisibility() {
    var bodyTab = document.querySelector('.tab[data-tab="body"]');
    if (!bodyTab) return;
    var showBody = state.method !== "GET";
    bodyTab.hidden = !showBody;
    if (!showBody) {
      setTab("headers");
    }
  }

  // --- Response ---------------------------------------------------------------

  function renderResponseEmpty(message) {
    $("response").innerHTML = '<div class="resp-empty">' + esc(message) + "</div>";
  }

  function renderError(error, durationMs) {
    $("response").innerHTML =
      '<div class="resp-error">' +
      '<span class="badge err">Error</span>' +
      '<span class="resp-msg">' +
      esc(error) +
      "</span>" +
      '<span class="resp-meta">' +
      esc(formatDuration(durationMs)) +
      "</span>" +
      "</div>";
  }

  function renderResponse(payload) {
    var headerRows = "";
    for (var i = 0; i < payload.headers.length; i++) {
      headerRows +=
        '<div class="rhdr"><span class="rhdr-k">' +
        esc(payload.headers[i][0]) +
        ':</span> <span class="rhdr-v">' +
        esc(payload.headers[i][1]) +
        "</span></div>";
    }

    $("response").innerHTML =
      '<div class="resp-status">' +
      '<span class="badge ' +
      statusClass(payload.status) +
      '">' +
      payload.status +
      " " +
      esc(payload.statusText) +
      "</span>" +
      '<span class="resp-meta">' +
      esc(formatDuration(payload.durationMs)) +
      "</span>" +
      '<span class="resp-meta">' +
      esc(formatSize(payload.body)) +
      "</span>" +
      (payload.headers.length
        ? '<button type="button" id="toggle-headers" class="resp-hbtn">Headers (' +
          payload.headers.length +
          ")</button>"
        : "") +
      "</div>" +
      '<div id="resp-headers" class="resp-headers" hidden>' +
      headerRows +
      "</div>" +
      '<pre class="resp-body">' +
      highlightJson(payload.body) +
      "</pre>";

    var toggle = $("toggle-headers");
    if (toggle) {
      toggle.addEventListener("click", function () {
        var block = $("resp-headers");
        block.hidden = !block.hidden;
      });
    }
  }

  // --- History ----------------------------------------------------------------

  function addHistoryEntry(entry) {
    var wrap = $("history");
    wrap.hidden = false;
    var list = $("history-list");

    var item = document.createElement("button");
    item.type = "button";
    item.className = "hist-item";

    var badge = entry.ok
      ? '<span class="badge ' + statusClass(entry.status) + '">' + entry.status + "</span>"
      : '<span class="badge err">Error</span>';

    item.innerHTML =
      '<span class="hist-method m-' +
      entry.method +
      '">' +
      entry.method +
      "</span>" +
      '<span class="hist-path">' +
      esc(entry.path) +
      "</span>" +
      badge;

    item.addEventListener("click", function () {
      state.method = entry.method;
      state.path = entry.path;
      $("method").value = entry.method;
      $("method").className = "m-" + entry.method;
      $("path").value = entry.path;
      updateBodyTabVisibility();
      if (entry.payload) {
        if (entry.ok) {
          renderResponse(entry.payload);
        } else {
          renderError(entry.payload.error, entry.payload.durationMs);
        }
      }
    });

    list.insertBefore(item, list.firstChild);
  }

  // --- Sending ----------------------------------------------------------------

  function updateSendEnabled() {
    var send = $("send");
    send.disabled = !state.ready || state.sending;
    send.textContent = state.sending ? "Sending…" : "Send";
  }

  function send() {
    if (!state.ready || state.sending) {
      return;
    }

    var headerRecord = {};
    for (var i = 0; i < state.headers.length; i++) {
      var header = state.headers[i];
      var key = header.key.replace(/^\s+|\s+$/g, "");
      if (header.enabled && key) {
        headerRecord[key] = header.value;
      }
    }

    var id = "api-req-" + ++idSeq;
    state.pendingId = id;
    state.sending = true;
    updateSendEnabled();
    renderResponseEmpty("Sending request…");

    var requestBody = state.method === "GET" ? undefined : state.body || undefined;

    window.parent.postMessage(
      {
        type: REQ,
        payload: {
          id: id,
          method: state.method,
          path: state.path,
          headers: headerRecord,
          body: requestBody,
        },
      },
      "*",
    );
  }

  function handleResult(payload) {
    if (!payload || payload.id !== state.pendingId) {
      return;
    }
    state.pendingId = null;
    state.sending = false;
    updateSendEnabled();

    if (payload.ok) {
      renderResponse(payload);
      addHistoryEntry({
        method: state.method,
        path: state.path,
        ok: true,
        status: payload.status,
        payload: payload,
      });
    } else {
      renderError(payload.error, payload.durationMs);
      addHistoryEntry({
        method: state.method,
        path: state.path,
        ok: false,
        payload: payload,
      });
    }
  }

  function setReady(ready) {
    state.ready = ready;
    $("banner").hidden = ready;
    updateSendEnabled();
  }

  // --- Wiring -----------------------------------------------------------------

  function init() {
    $("method").addEventListener("change", function () {
      state.method = $("method").value;
      $("method").className = "m-" + state.method;
      updateBodyTabVisibility();
    });

    $("path").addEventListener("input", function () {
      state.path = $("path").value;
    });
    $("path").addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        send();
      }
    });

    $("send").addEventListener("click", send);
    $("add-header").addEventListener("click", function () {
      var header = { key: "", value: "", enabled: true };
      state.headers.push(header);
      addHeaderRow(header);
      updateTabLabels();
    });

    $("body").addEventListener("input", function () {
      state.body = $("body").value;
    });

    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      (function (tab) {
        tab.addEventListener("click", function () {
          setTab(tab.getAttribute("data-tab"));
        });
      })(tabs[i]);
    }

    $("clear-history").addEventListener("click", function () {
      $("history-list").innerHTML = "";
      $("history").hidden = true;
    });

    $("method").className = "m-GET";
    updateBodyTabVisibility();
    updateSendEnabled();

    window.addEventListener("message", function (event) {
      var data = event.data || {};
      if (data.type === RES) {
        handleResult(data.payload);
      } else if (data.type === READY) {
        setReady(Boolean(data.payload && data.payload.ready));
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
