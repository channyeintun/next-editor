import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

// Extension-tests entry that hosts the renderer benchmark webview and
// collects its results (plan §11.3). Invoked via launch.ts, not mocha.
export async function run(): Promise<void> {
  const extensionRoot = path.resolve(__dirname, "..", "..");
  const benchmarkDist = path.join(extensionRoot, "dist", "benchmark");
  if (!fs.existsSync(path.join(benchmarkDist, "benchmark.js"))) {
    throw new Error("dist/benchmark/benchmark.js missing — run the benchmark build first");
  }

  const outFile =
    process.env.BENCH_OUT ?? path.join(extensionRoot, ".artifacts", "renderer-benchmark.json");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const panel = vscode.window.createWebviewPanel(
    "nextRecording.benchmark",
    "Renderer Benchmark",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(benchmarkDist)],
    },
  );

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(benchmarkDist, "benchmark.js")),
  );
  const cssPath = path.join(benchmarkDist, "benchmark.css");
  const styleTag = fs.existsSync(cssPath)
    ? `<link rel="stylesheet" href="${panel.webview.asWebviewUri(vscode.Uri.file(cssPath)).toString()}">`
    : "";
  const nonce = Math.random().toString(36).slice(2);
  // Benchmark-only CSP: inline styles for the editors, blob workers for
  // Monaco's inlined editor worker. The shipping player CSP stays strict.
  panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource}; img-src ${panel.webview.cspSource} data:; script-src 'nonce-${nonce}'; worker-src blob: data:;">
  ${styleTag}
</head>
<body style="background:#1e1e1e">
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri.toString()}"></script>
</body>
</html>`;

  const results: unknown[] = [];

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("benchmark timed out after 20 minutes")),
      20 * 60 * 1000,
    );
    panel.webview.onDidReceiveMessage((message: { type?: string; [k: string]: unknown }) => {
      switch (message.type) {
        case "bench.ready":
          console.log("[bench] webview ready, starting");
          void panel.webview.postMessage({ type: "bench.start" });
          break;
        case "bench.progress":
          console.log(`[bench] ${String(message.note)}`);
          break;
        case "bench.result": {
          const result = message.result as {
            renderer: string;
            fixture: string;
          };
          console.log(`[bench] result: ${result.renderer}/${result.fixture}`);
          results.push(message.result);
          break;
        }
        case "bench.done":
          clearTimeout(timeout);
          resolve();
          break;
        default:
          break;
      }
    });
    panel.onDidDispose(() => {
      clearTimeout(timeout);
      reject(new Error("benchmark webview disposed before completion"));
    });
  });

  // Attribute bundle sizes per candidate from the manualChunks output.
  const bundle: Record<string, number> = {};
  for (const file of fs.readdirSync(benchmarkDist)) {
    const size = fs.statSync(path.join(benchmarkDist, file)).size;
    bundle[file] = size;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    hardware: `${process.platform} ${process.arch}`,
    vscodeVersion: vscode.version,
    electronNode: process.versions.node,
    buildMode: "vite production (minified)",
    bundleFiles: bundle,
    results,
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
  console.log(`[bench] report written to ${outFile}`);
}
