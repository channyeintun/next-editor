import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceProject } from "../types/workspace";
import {
  createRuntimePreviewScript,
  createWorkspaceTree,
  isMobileBrowser,
  isWebContainerRuntimeSupported,
  parseCommand,
} from "./webContainerRuntimeSupport";

function nodeProject(htmlContent: string): WorkspaceProject {
  return {
    id: "project-1",
    name: "Project",
    lessonType: "react",
    entryFilePath: "index.html",
    folders: [],
    files: {
      "index.html": {
        path: "index.html",
        name: "index.html",
        language: "html",
        content: htmlContent,
      },
    },
  };
}

function getIndexHtml(tree: ReturnType<typeof createWorkspaceTree>): string {
  const entry = tree["index.html"];
  if (!entry || !("file" in entry) || !("contents" in entry.file)) {
    throw new Error("index.html not found in workspace tree");
  }
  const { contents } = entry.file;
  if (typeof contents !== "string") {
    throw new Error("Expected index.html contents to be a string");
  }
  return contents;
}

describe("createRuntimePreviewScript", () => {
  it("bundles the rrweb recorder and snapshot wiring into one injectable script", () => {
    const script = createRuntimePreviewScript();

    expect(script).toContain("window.rrwebRecord.record");
    // The vendored UMD bundle is inlined (its IIFE header is present).
    expect(script).toContain("function (g, f)");
    // The snapshot/postMessage wiring keyed on the runtime snapshot message type.
    expect(script).toContain("NEXT_EDITOR_RUNTIME_SNAPSHOT");
    expect(script).toContain("NEXT_EDITOR_REQUEST_RUNTIME_SNAPSHOT");
    expect(script).not.toContain("new MutationObserver(schedule)");
    expect(script).toContain('window.addEventListener("message"');
    expect(script).toContain("minIntervalMs=100");
    expect(script).toContain("NEXT_EDITOR_PREVIEW_SCREENSHOT_REQUEST");
    expect(script).toContain("NEXT_EDITOR_PREVIEW_SCREENSHOT_RESPONSE");
  });

  it("emits no closing </script> so it survives being wrapped in a <script> tag", () => {
    // setPreviewScript supplies the surrounding <script> tag; a literal </script>
    // inside the bundle/wiring would close it early and break every preview.
    const script = createRuntimePreviewScript();
    const closings = script.match(/<\/script>/gi)?.length ?? 0;

    expect(closings).toBe(0);
  });
});

describe("isMobileBrowser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubNavigator = (navigator: Partial<Navigator> & Record<string, unknown>) => {
    vi.stubGlobal("navigator", navigator);
  };

  it("honors the userAgentData.mobile client hint when present", () => {
    stubNavigator({ userAgent: "Mozilla/5.0", userAgentData: { mobile: true } });
    expect(isMobileBrowser()).toBe(true);

    stubNavigator({ userAgent: "Mozilla/5.0", userAgentData: { mobile: false } });
    expect(isMobileBrowser()).toBe(false);
  });

  it("detects phone user agents", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      maxTouchPoints: 5,
    });
    expect(isMobileBrowser()).toBe(true);

    stubNavigator({
      userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Mobile Safari/537.36",
      maxTouchPoints: 5,
    });
    expect(isMobileBrowser()).toBe(true);
  });

  it("treats a touch-capable Macintosh as iPadOS (tablet)", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Safari/605.1.15",
      maxTouchPoints: 5,
    });
    expect(isMobileBrowser()).toBe(true);
  });

  it("treats a real desktop (no touch) as not mobile", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      maxTouchPoints: 0,
    });
    expect(isMobileBrowser()).toBe(false);
  });
});

describe("isWebContainerRuntimeSupported", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires both cross-origin isolation and a non-mobile browser", () => {
    const desktop = {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/120 Safari/537.36",
      maxTouchPoints: 0,
    };
    const phone = {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148",
      maxTouchPoints: 5,
    };

    vi.stubGlobal("navigator", desktop);
    vi.stubGlobal("crossOriginIsolated", true);
    expect(isWebContainerRuntimeSupported()).toBe(true);

    // Cross-origin isolation off → unsupported even on desktop.
    vi.stubGlobal("crossOriginIsolated", false);
    expect(isWebContainerRuntimeSupported()).toBe(false);

    // Mobile is excluded even with cross-origin isolation on.
    vi.stubGlobal("navigator", phone);
    vi.stubGlobal("crossOriginIsolated", true);
    expect(isWebContainerRuntimeSupported()).toBe(false);
  });
});

describe("createWorkspaceTree", () => {
  it("mounts html files verbatim (the recorder is injected at the preview layer)", () => {
    const original = "<html><head></head><body>Hi</body></html>";
    const html = getIndexHtml(createWorkspaceTree(nodeProject(original)));

    expect(html).toBe(original);
    expect(html).not.toContain("data-next-editor-rrweb-record");
    expect(html).not.toContain("data-next-editor-runtime-snapshot");
  });

  it("rejects unsafe and structurally conflicting paths", () => {
    const conflict = nodeProject("root");
    conflict.files.src = {
      path: "src",
      name: "src",
      language: "plaintext",
      content: "file",
    };
    conflict.files["src/App.tsx"] = {
      path: "src/App.tsx",
      name: "App.tsx",
      language: "typescript",
      content: "nested",
    };

    expect(() => createWorkspaceTree(conflict)).toThrow(/conflict/i);

    const reserved = nodeProject("root");
    reserved.files["__proto__/secret.txt"] = {
      path: "__proto__/secret.txt",
      name: "secret.txt",
      language: "plaintext",
      content: "secret",
    };
    expect(() => createWorkspaceTree(reserved)).toThrow(/reserved/i);

    const mismatched = nodeProject("root");
    mismatched.files["alias.txt"] = {
      path: "actual.txt",
      name: "actual.txt",
      language: "plaintext",
      content: "mismatch",
    };
    expect(() => createWorkspaceTree(mismatched)).toThrow(/does not match/i);
  });
});

describe("parseCommand", () => {
  it("delegates free-form runner commands to the sandbox shell", () => {
    const command = 'GREETING="hello world" printf "%s\\n" "$GREETING" | tee "out file.txt"';

    expect(parseCommand(command)).toEqual({ command: "sh", args: ["-lc", command] });
    expect(parseCommand("  \t\n ")).toBeNull();
  });

  it("preserves empty arguments, escaped spaces, operators, and Unicode whitespace", () => {
    const commands = [
      'printf "<%s>" ""',
      "printf %s escaped\\ space",
      "NAME=value sh -c 'printf %s \"$NAME\"' > output.txt",
      "printf 'left' && printf 'right'",
      "printf 'a\u2003b'",
    ];

    for (const command of commands) {
      expect(parseCommand(command)).toEqual({ command: "sh", args: ["-lc", command] });
    }
  });
});
