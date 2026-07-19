import * as vscode from "vscode";

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

// The webview HTML is generated here (no shipped index.html) so the CSP
// nonce is fresh per resolve and resource URIs go through asWebviewUri.
export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = makeNonce();
  const webviewDist = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDist, "webview.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDist, "webview.css"));

  const csp = [
    "default-src 'none'",
    // Monaco injects <style> elements at runtime; no remote styles exist.
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    // Monaco's editor worker ships inlined and boots from a blob URL.
    "worker-src blob: data:",
    // Audio playback (Phase 8) will require media-src from the local cache.
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>Next Recording Player</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
