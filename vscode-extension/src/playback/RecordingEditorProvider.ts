import * as vscode from "vscode";
import { PLAYER_VIEW_TYPE } from "../model/ids";
import { getWebviewHtml } from "./getWebviewHtml";

class RecordingCustomDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}

  dispose(): void {
    // Phase 6 adds artifact readers and cache leases to release here.
  }
}

// Phase 1 placeholder player: proves the custom editor association, the
// webview CSP wiring, and the ready handshake. Artifact parsing and the
// real player arrive in Phase 6.
export class RecordingEditorProvider implements vscode.CustomReadonlyEditorProvider<RecordingCustomDocument> {
  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      PLAYER_VIEW_TYPE,
      new RecordingEditorProvider(context.extensionUri),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: false },
      },
    );
  }

  constructor(private readonly extensionUri: vscode.Uri) {}

  openCustomDocument(uri: vscode.Uri): RecordingCustomDocument {
    return new RecordingCustomDocument(uri);
  }

  async resolveCustomEditor(
    document: RecordingCustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };
    webview.html = getWebviewHtml(webview, this.extensionUri);

    const stat = await vscode.workspace.fs.stat(document.uri);

    const subscription = webview.onDidReceiveMessage((message: unknown) => {
      const type =
        typeof message === "object" && message !== null && "type" in message
          ? (message as { type: unknown }).type
          : undefined;
      if (type === "webview.ready") {
        void webview.postMessage({ type: "host.hello", protocolVersion: 1 });
        void webview.postMessage({
          type: "recording.metadata",
          payload: {
            fileName: document.uri.path.split("/").pop() ?? document.uri.path,
            byteLength: stat.size,
          },
        });
      }
    });

    webviewPanel.onDidDispose(() => subscription.dispose());
  }
}
