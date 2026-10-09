/* oxlint-disable vitest/require-mock-type-parameters */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The seven runner panels, driven through fake runtime clients: the panels (and
// whatever hooks sit behind them) are real, the network and the in-page
// compilers are not.
const harness = vi.hoisted(() => {
  // The session, editor and collaboration hooks re-render their caller when
  // their value changes, as the real ones do; a test changes `state`, then
  // calls notify().
  const listeners = new Set<() => void>();
  const reactive = {
    version: 0,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => reactive.version,
    notify: () => {
      reactive.version += 1;
      for (const listener of listeners) listener();
    },
  };
  const state = {
    // No panel reads the session any more. The mock below stays so that a
    // sign-in gate added back to the dock would see these states in tests.
    auth: { isSignedIn: true, isLoading: false },
    metadata: { currentRecording: null as unknown, isRecording: false, isPlaying: false },
    project: { id: "project-1", files: {} as Record<string, { path: string; content: string }> },
    collaboration: null as unknown,
  };
  const client = {
    run: vi.fn<(language: string, request: unknown) => Promise<unknown>>(),
    format: vi.fn<(language: string, request: unknown) => Promise<unknown>>(),
    stop: vi.fn<(language: string) => void>(),
  };
  const clientClass = (language: string) =>
    class FakePlaygroundClient {
      run(request: unknown) {
        return client.run(language, request);
      }
      format(request: unknown) {
        return client.format(language, request);
      }
      abort() {
        client.stop(language);
      }
      dispose() {
        client.stop(language);
      }
    };
  const workspace = {
    getProject: () => state.project,
    updateFileContent: vi.fn(),
  };
  const actions = { editorRef: { current: null }, handleRuntimeEvent: vi.fn() };
  const providers: {
    languageId: string;
    displayName: string;
    provide: (model: unknown, options: unknown, token: unknown) => Promise<unknown>;
    disposed: boolean;
  }[] = [];
  return { state, client, clientClass, workspace, actions, providers, reactive };
});

vi.mock("@next-editor/infra", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAuth: () => {
      useSyncExternalStore(harness.reactive.subscribe, harness.reactive.getVersion);
      return harness.state.auth;
    },
  };
});
vi.mock("../hooks/useNextEditorContext", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useNextEditorActions: () => harness.actions,
    useNextEditorMetadata: () => {
      useSyncExternalStore(harness.reactive.subscribe, harness.reactive.getVersion);
      return harness.state.metadata;
    },
  };
});
vi.mock("../hooks/useWorkspace", () => ({
  useWorkspaceActions: () => harness.workspace,
  useWorkspaceProjectVersion: () => 1,
}));
vi.mock("../contexts/CollaborationContext", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useOptionalCollaboration: () => {
      useSyncExternalStore(harness.reactive.subscribe, harness.reactive.getVersion);
      return harness.state.collaboration;
    },
  };
});
vi.mock("../monaco", () => ({
  monaco: {
    languages: {
      registerDocumentFormattingEditProvider: (
        languageId: string,
        provider: {
          displayName: string;
          provideDocumentFormattingEdits: (...args: unknown[]) => Promise<unknown>;
        },
      ) => {
        const registration = {
          languageId,
          displayName: provider.displayName,
          provide: provider.provideDocumentFormattingEdits,
          disposed: false,
        };
        harness.providers.push(registration);
        return { dispose: () => (registration.disposed = true) };
      },
    },
  },
  workspacePathFromMonacoModelUri: (uri: { toString(): string }) =>
    uri.toString().replace("file:///", ""),
}));
vi.mock("./XtermTerminal", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: { sessionId: string; output: string; scrollLine?: number }) =>
      createElement(
        "pre",
        {
          "data-testid": "console",
          "data-session": props.sessionId,
          "data-scroll-line": String(props.scrollLine),
        },
        props.output,
      ),
  };
});
vi.mock("./agent/AgentPanel", () => ({ default: () => null }));
vi.mock("../runtime/goPlayground/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/goPlayground/client")>()),
  GoPlaygroundClient: harness.clientClass("go"),
}));
vi.mock("../runtime/rustPlayground/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/rustPlayground/client")>()),
  RustPlaygroundClient: harness.clientClass("rust"),
}));
vi.mock("../runtime/zigPlayground/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/zigPlayground/client")>()),
  ZigPlaygroundClient: harness.clientClass("zig"),
}));
vi.mock("../runtime/kitePlayground/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/kitePlayground/client")>()),
  KitePlaygroundClient: harness.clientClass("kite"),
}));
vi.mock("../runtime/haskellPlayground/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/haskellPlayground/client")>()),
  HaskellPlaygroundClient: harness.clientClass("haskell"),
}));
vi.mock("../runtime/kotlinPlayground/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/kotlinPlayground/client")>()),
  KotlinPlaygroundClient: harness.clientClass("kotlin"),
}));
vi.mock("../runtime/asmPlayground/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/asmPlayground/client")>()),
  AsmPlaygroundClient: harness.clientClass("asm"),
}));

import {
  RuntimePanelStoreProvider,
  useRuntimePanelStore,
} from "../contexts/RuntimePanelStoreContext";
import type { RuntimePanelStoreInstance } from "../stores/runtimePanelStore";
import type { StudioPlaygroundRuntimeKind } from "../studio/plan";
import { dockTargetIdForRuntime, STUDIO_RUN_BUTTON_TARGET_ID } from "../studio/targets";
import { GoPlaygroundServiceError } from "../runtime/goPlayground/client";
import { HaskellPlaygroundServiceError } from "../runtime/haskellPlayground/client";
import AsmPlaygroundRunnerPanel, { ASM_RUNNER } from "./AsmPlaygroundRunnerPanel";
import GoPlaygroundRunnerPanel, { GO_RUNNER } from "./GoPlaygroundRunnerPanel";
import HaskellPlaygroundRunnerPanel, { HASKELL_RUNNER } from "./HaskellPlaygroundRunnerPanel";
import KitePlaygroundRunnerPanel, { KITE_RUNNER } from "./KitePlaygroundRunnerPanel";
import KotlinPlaygroundRunnerPanel, { KOTLIN_RUNNER } from "./KotlinPlaygroundRunnerPanel";
import RustPlaygroundRunnerPanel, { RUST_RUNNER } from "./RustPlaygroundRunnerPanel";
import ZigPlaygroundRunnerPanel, { ZIG_RUNNER } from "./ZigPlaygroundRunnerPanel";

const RED = "\u001b[91m";
const YELLOW = "\u001b[93m";
const GREEN = "\u001b[92m";
const DIM = "\u001b[90m";
const RESET = "\u001b[0m";

/** A console line as the dock prints it: the tag coloured, the rest dimmed. */
const decorated = (color: string, tag: string, rest: string) =>
  `${color}${tag}${RESET}${DIM}${rest}${RESET}`;

interface FormatCase {
  monacoLanguageId: string;
  providerName: string;
  command: string;
  busyLabel: string;
  title: string;
  /** What Format prints when it changes the lesson file. */
  formattedLines: string[];
  readOnlyLine: string;
  refused: { files: Record<string, string>; line: string };
}

interface PanelCase {
  kind: StudioPlaygroundRuntimeKind;
  Panel: ComponentType;
  /** The panel's PlaygroundRunnerLanguage, as far as the studio checks it. */
  language: { dockTargetId: string; scrollSurface: string };
  surface: string;
  runnerTab: string;
  command: string;
  entry: string;
  /** The console lines a Run of `entry` prints before and after `result`. */
  run: { result: unknown; lines: string[] };
  refusedRun: { files: Record<string, string>; line: string } | null;
  tags: { error: string; success: string; warning: string | null };
  format: FormatCase | null;
}

const CASES: PanelCase[] = [
  {
    kind: "go-playground",
    Panel: GoPlaygroundRunnerPanel,
    language: GO_RUNNER,
    surface: "go-runner",
    runnerTab: "Go Runner",
    command: "go run *.go",
    entry: "main.go",
    run: {
      result: { status: "success", output: "hello\n", exitCode: 0 },
      lines: ["[go-run] go run main.go", "hello", "[go-run] Program exited"],
    },
    refusedRun: {
      files: { "README.md": "# Lesson" },
      line: "[go-run error] Add at least one .go file to run this lesson",
    },
    tags: { error: "[gofmt error]", success: "[go-run]", warning: "[go-vet]" },
    format: {
      monacoLanguageId: "go",
      providerName: "gofmt (Go Playground)",
      command: "gofmt *.go",
      busyLabel: "Go files are formatting",
      title: "Format every Go file with gofmt (Shift+Alt+F)",
      formattedLines: ["[gofmt] gofmt main.go", "[gofmt] Formatted main.go"],
      readOnlyLine: "[gofmt error] This shared lesson is read-only",
      refused: {
        files: { "README.md": "# Lesson" },
        line: "[gofmt error] Add at least one .go file to format this lesson",
      },
    },
  },
  {
    kind: "rust-playground",
    Panel: RustPlaygroundRunnerPanel,
    language: RUST_RUNNER,
    surface: "rust-runner",
    runnerTab: "Rust Runner",
    command: "cargo run",
    entry: "main.rs",
    run: {
      result: { status: "success", stdout: "hi\n", stderr: "" },
      lines: ["[rust-run] cargo run", "hi", "[rust-run] Program exited"],
    },
    refusedRun: {
      files: { "main.rs": "fn main() {}\n", "lib.rs": "pub fn x() {}\n" },
      line: "[rust-run error] Rust lessons run a single main.rs file",
    },
    tags: { error: "[rustfmt error]", success: "[rust-run]", warning: null },
    format: {
      monacoLanguageId: "rust",
      providerName: "rustfmt (Rust Playground)",
      command: "rustfmt main.rs",
      busyLabel: "main.rs is formatting",
      title: "Format main.rs with rustfmt (Shift+Alt+F)",
      formattedLines: ["[rustfmt] rustfmt main.rs", "[rustfmt] Formatted main.rs"],
      readOnlyLine: "[rustfmt error] This shared lesson is read-only",
      refused: {
        files: { "lib.rs": "pub fn x() {}\n" },
        line: "[rustfmt error] Rust lessons format a single main.rs file",
      },
    },
  },
  {
    kind: "zig-playground",
    Panel: ZigPlaygroundRunnerPanel,
    language: ZIG_RUNNER,
    surface: "zig-runner",
    runnerTab: "Zig Runner",
    command: "zig run main.zig",
    entry: "main.zig",
    run: {
      result: { status: "success", output: "hi\n" },
      lines: ["[zig-run] zig run main.zig", "hi", "[zig-run] Program exited"],
    },
    refusedRun: {
      files: { "lib.zig": "pub fn x() void {}\n" },
      line: "[zig-run error] Zig lessons run a single main.zig file",
    },
    tags: { error: "[zig-fmt error]", success: "[zig-run]", warning: null },
    format: {
      monacoLanguageId: "zig",
      providerName: "zig fmt (Zig Playground)",
      command: "zig fmt main.zig",
      busyLabel: "main.zig is formatting",
      title: "Format main.zig with zig fmt (Shift+Alt+F)",
      formattedLines: ["[zig-fmt] zig fmt main.zig", "[zig-fmt] Formatted main.zig"],
      readOnlyLine: "[zig-fmt error] This shared lesson is read-only",
      refused: {
        files: { "main.zig": "pub fn main() void {}\n", "lib.zig": "pub fn x() void {}\n" },
        line: "[zig-fmt error] Zig lessons format a single main.zig file",
      },
    },
  },
  {
    kind: "kite-playground",
    Panel: KitePlaygroundRunnerPanel,
    language: KITE_RUNNER,
    surface: "kite-runner",
    runnerTab: "Kite Runner",
    command: "kitec run main.kite",
    entry: "main.kite",
    run: {
      result: { status: "success", stdout: "hi\n", stderr: "" },
      lines: ["[kite-run] kitec run main.kite", "hi", "[kite-run] Program exited"],
    },
    refusedRun: null,
    tags: { error: "[kitefmt error]", success: "[kite-run]", warning: null },
    format: {
      monacoLanguageId: "kite",
      providerName: "kitec fmt (Kite)",
      command: "kitec fmt main.kite",
      busyLabel: "main.kite is formatting",
      title: "Format main.kite with kitec fmt (Shift+Alt+F)",
      formattedLines: ["[kitefmt] kitec fmt main.kite", "[kitefmt] Formatted main.kite"],
      readOnlyLine: "[kitefmt error] This shared lesson is read-only",
      refused: {
        files: { "README.md": "# Lesson" },
        line: "[kitefmt error] Add a .kite file to format this lesson",
      },
    },
  },
  {
    kind: "haskell-playground",
    Panel: HaskellPlaygroundRunnerPanel,
    language: HASKELL_RUNNER,
    surface: "haskell-runner",
    runnerTab: "Haskell Runner",
    command: "runghc Main.hs",
    entry: "Main.hs",
    run: {
      result: { status: "success", stdout: "[1,2,3]\n", stderr: "" },
      lines: ["[haskell-run] runghc Main.hs", "[1,2,3]", "[haskell-run] Program exited"],
    },
    refusedRun: {
      files: { "main.hs": "main = pure ()\n" },
      line: "[haskell-run error] Haskell lessons run a single Main.hs file",
    },
    tags: { error: "[haskell-run error]", success: "[haskell-run]", warning: "[haskell-warn]" },
    format: null,
  },
  {
    kind: "kotlin-playground",
    Panel: KotlinPlaygroundRunnerPanel,
    language: KOTLIN_RUNNER,
    surface: "kotlin-runner",
    runnerTab: "Kotlin Runner",
    command: "kotlin *.kt",
    entry: "Main.kt",
    run: {
      result: { status: "success", output: "[1, 2]\n" },
      lines: ["[kotlin-run] kotlin Main.kt", "[1, 2]", "[kotlin-run] Program exited"],
    },
    refusedRun: {
      files: { "README.md": "# Lesson" },
      line: "[kotlin-run error] Add at least one .kt file to run this lesson",
    },
    tags: { error: "[kotlin-run error]", success: "[kotlin-run]", warning: "[kotlin-warn]" },
    format: null,
  },
  {
    kind: "asm-playground",
    Panel: AsmPlaygroundRunnerPanel,
    language: ASM_RUNNER,
    surface: "asm-runner",
    runnerTab: "Assembly Runner",
    command: "nasm -f elf64 main.asm && ld -o main main.o && ./main",
    entry: "main.asm",
    run: {
      result: {
        status: "success",
        stdout: "hi\n",
        stderr: "",
        exitCode: 0,
        registers: [{ name: "rax", value: "60" }],
      },
      lines: [
        "[asm-run] nasm -f elf64 main.asm && ld -o main main.o && ./main",
        "hi",
        "[asm-run] Program exited with status 0",
        "[asm-run] rax=0x3c",
      ],
    },
    refusedRun: null,
    tags: { error: "[asm-run error]", success: "[asm-run]", warning: null },
    format: null,
  },
];

const FORMAT_CASES = CASES.filter(
  (panel): panel is PanelCase & { format: FormatCase } => panel.format !== null,
);

const SOURCE = "unformatted  source\n";
const FORMATTED = "unformatted source\n";

function setFiles(files: Record<string, string>, id = "project-1") {
  harness.state.project = {
    id,
    files: Object.fromEntries(
      Object.entries(files).map(([path, content]) => [path, { path, content }]),
    ),
  };
}

function formatEveryFile() {
  harness.client.format.mockImplementation(async (_language, request) => {
    const files = Array.isArray(request)
      ? request
      : (request as { files: { path: string; content: string }[] }).files;
    return { files: files.map((file) => ({ ...file, content: file.content.replace("  ", " ") })) };
  });
}

function model(path: string, content: string) {
  return {
    uri: { toString: () => `file:///${path}` },
    getVersionId: () => 1,
    getValue: () => content,
    isDisposed: () => false,
    getFullModelRange: () => ({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 1,
    }),
  };
}

let store: RuntimePanelStoreInstance;

function StoreProbe() {
  store = useRuntimePanelStore().store;
  return null;
}

async function renderPanel({ Panel }: PanelCase) {
  const view = render(
    <RuntimePanelStoreProvider>
      <StoreProbe />
      <Panel />
    </RuntimePanelStoreProvider>,
  );
  await act(async () => {});
  return view;
}

async function click(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const consoleLines = () => store.getSnapshot().context.consoleLines;
const activeProviders = () => harness.providers.filter((provider) => !provider.disposed);

describe("playground runner panels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.providers.length = 0;
    harness.state.auth = { isSignedIn: true, isLoading: false };
    harness.state.metadata = { currentRecording: null, isRecording: false, isPlaying: false };
    harness.state.collaboration = null;
    harness.client.run.mockReturnValue(new Promise(() => {}));
    harness.client.format.mockReturnValue(new Promise(() => {}));
  });

  afterEach(() => {
    cleanup();
  });

  it.each(CASES)("$kind: names its dock, runner tab, command and console", async (panel) => {
    setFiles({ [panel.entry]: SOURCE });
    const { container } = await renderPanel(panel);

    const dock = container.firstElementChild;
    expect(dock).toHaveAttribute("data-studio-target", dockTargetIdForRuntime(panel.kind));
    expect(dock).toHaveAttribute("data-cursor-replay-target", "runtime-dock");
    expect(screen.getByRole("button", { name: panel.runnerTab })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("data-tour", "agent");
    expect(screen.getByText(panel.command, { selector: "p" })).toBeInTheDocument();
    expect(screen.getByTestId("console")).toHaveAttribute("data-session", panel.surface);
    expect(screen.getByRole("button", { name: "Run" })).toHaveAttribute(
      "data-studio-target",
      STUDIO_RUN_BUTTON_TARGET_ID,
    );
  });

  it.each(CASES)(
    "$kind: keeps the height and collapse controls outside the scrolling tab strip",
    async (panel) => {
      setFiles({ [panel.entry]: SOURCE });
      await renderPanel(panel);

      // On a narrow phone dock the tabs scroll inside their own strip; the
      // controls after it must not scroll or shrink with it, or the viewer's
      // full-height toggle is clipped off the end of the header.
      const tabStrip = screen.getByRole("button", { name: panel.runnerTab }).parentElement;
      expect(tabStrip).toHaveClass("min-w-0", "overflow-x-auto");
      for (const name of ["Expand runtime dock to full height", "Collapse runtime dock"]) {
        const control = screen.getByRole("button", { name });
        expect(tabStrip).not.toContainElement(control);
        expect(control).toHaveClass("shrink-0", "size-10");
      }
    },
  );

  // Run needs no sign-in for any language: the proxied ones (Go, Rust, Zig,
  // Haskell, Kotlin) are rate-limited by IP when signed out, and Kite and
  // assembly never call a service at all.
  it.each(CASES)("$kind: runs signed out, with no sign-in button", async (panel) => {
    setFiles({ [panel.entry]: SOURCE });
    harness.client.run.mockResolvedValue(panel.run.result);
    harness.state.auth = { isSignedIn: false, isLoading: false };
    await renderPanel(panel);

    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
    await click(screen.getByRole("button", { name: "Run" }));

    expect(harness.client.run).toHaveBeenCalledTimes(1);
    expect(consoleLines()).toEqual(panel.run.lines);
  });

  it.each(CASES)("$kind: never waits for a session", async (panel) => {
    setFiles({ [panel.entry]: SOURCE });
    harness.state.auth = { isSignedIn: false, isLoading: true };
    await renderPanel(panel);

    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
  });

  it.each(CASES.filter((panel) => panel.refusedRun !== null))(
    "$kind: refuses a workspace the lesson cannot run",
    async (panel) => {
      setFiles(panel.refusedRun!.files);
      await renderPanel(panel);

      await click(screen.getByRole("button", { name: "Run" }));

      expect(consoleLines()).toEqual([panel.refusedRun!.line]);
      expect(harness.client.run).not.toHaveBeenCalled();
      expect(screen.getByRole("status").textContent).toBe(
        panel.refusedRun!.line.replace(/^\[[^\]]+\] /, ""),
      );
    },
  );

  it.each(CASES)("$kind: runs the lesson through its client", async (panel) => {
    setFiles({ [panel.entry]: SOURCE, "README.md": "# Lesson" });
    harness.client.run.mockResolvedValue(panel.run.result);
    await renderPanel(panel);

    await click(screen.getByRole("button", { name: "Run" }));

    expect(harness.client.run).toHaveBeenCalledTimes(1);
    const [, request] = harness.client.run.mock.calls[0];
    const files = Array.isArray(request) ? request : (request as { files: unknown }).files;
    expect(files).toEqual([{ path: panel.entry, content: SOURCE }]);
    expect(consoleLines()).toEqual(panel.run.lines);
  });

  it("go: prints the service's reason, and the detail of a program it refused", async () => {
    const [go] = CASES;
    setFiles({ "main.go": SOURCE });
    harness.client.run.mockRejectedValue(
      new GoPlaygroundServiceError("invalid-source", 'import "os/exec" is not allowed'),
    );
    await renderPanel(go);

    await click(screen.getByRole("button", { name: "Run" }));

    expect(consoleLines()).toEqual([
      "[go-run] go run main.go",
      "[go-run error] This program can't run in a Go lesson",
      'import "os/exec" is not allowed',
    ]);
  });

  it("go: says in its status region that a run is busy, then how it ended", async () => {
    const [go] = CASES;
    setFiles({ "main.go": SOURCE });
    let finishRun: (result: unknown) => void = () => {};
    harness.client.run.mockReturnValue(new Promise((resolve) => (finishRun = resolve)));
    await renderPanel(go);
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();

    await click(screen.getByRole("button", { name: "Run" }));
    expect(status).toHaveTextContent("Program is running");

    await act(async () => {
      finishRun(go.run.result);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("Program exited");
  });

  it("go: names a refused program's failure ahead of the service's detail", async () => {
    const [go] = CASES;
    setFiles({ "main.go": SOURCE });
    harness.client.run.mockRejectedValue(
      new GoPlaygroundServiceError("invalid-source", 'import "os/exec" is not allowed'),
    );
    await renderPanel(go);

    await click(screen.getByRole("button", { name: "Run" }));

    expect(screen.getByRole("status").textContent).toBe("This program can't run in a Go lesson");
  });

  it("go: keeps its status region while the dock is collapsed", async () => {
    const [go] = CASES;
    setFiles({ "main.go": SOURCE });
    await renderPanel(go);
    const status = screen.getByRole("status");

    await click(screen.getByRole("button", { name: "Collapse runtime dock" }));

    expect(screen.queryByTestId("console")).toBeNull();
    expect(screen.getByRole("status")).toBe(status);
  });

  it("haskell: says nothing for a run a newer one superseded", async () => {
    const haskell = CASES.find((panel) => panel.kind === "haskell-playground")!;
    setFiles({ "Main.hs": SOURCE });
    harness.client.run.mockRejectedValue(
      new HaskellPlaygroundServiceError("aborted", "superseded"),
    );
    await renderPanel(haskell);

    await click(screen.getByRole("button", { name: "Run" }));

    expect(consoleLines()).toEqual(["[haskell-run] runghc Main.hs"]);
  });

  it.each(CASES)("$kind: colours only the tags its own console emits", async (panel) => {
    setFiles({ [panel.entry]: SOURCE });
    await renderPanel(panel);
    const foreignTag = panel.kind === "go-playground" ? "[rust-run]" : "[go-run]";
    const lines = [
      `${panel.tags.error} failed`,
      `${panel.tags.success} done`,
      ...(panel.tags.warning ? [`${panel.tags.warning} careful`] : []),
      `${foreignTag} not ours`,
      "[1, 2, 3]",
    ];

    act(() => store.trigger.setConsoleLines({ consoleLines: lines }));

    expect(screen.getByTestId("console").textContent).toBe(
      [
        decorated(RED, panel.tags.error, " failed"),
        decorated(GREEN, panel.tags.success, " done"),
        ...(panel.tags.warning ? [decorated(YELLOW, panel.tags.warning, " careful")] : []),
        `${foreignTag} not ours`,
        "[1, 2, 3]",
      ].join("\n"),
    );
  });

  it.each(FORMAT_CASES)(
    "$kind: offers Format and registers its Monaco formatter",
    async (panel) => {
      setFiles({ [panel.entry]: SOURCE });
      await renderPanel(panel);

      expect(screen.getByRole("button", { name: "Format" })).toHaveAttribute(
        "title",
        panel.format.title,
      );
      expect(activeProviders()).toEqual([
        expect.objectContaining({
          languageId: panel.format.monacoLanguageId,
          displayName: panel.format.providerName,
        }),
      ]);
    },
  );

  it.each(CASES.filter((panel) => panel.format === null))(
    "$kind: has no formatter to offer or register",
    async (panel) => {
      setFiles({ [panel.entry]: SOURCE });
      await renderPanel(panel);

      expect(screen.queryByRole("button", { name: "Format" })).toBeNull();
      expect(harness.providers).toEqual([]);
    },
  );

  it.each(FORMAT_CASES)("$kind: formats the open file as a Monaco edit", async (panel) => {
    setFiles({ [panel.entry]: SOURCE });
    formatEveryFile();
    await renderPanel(panel);

    let edits: unknown;
    await act(async () => {
      edits = await activeProviders()[0].provide(
        model(panel.entry, SOURCE),
        {},
        {
          isCancellationRequested: false,
        },
      );
    });

    expect(edits).toEqual([
      {
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 },
        text: FORMATTED,
      },
    ]);
    // The open file changes through the edit, so Monaco keeps its undo stack.
    expect(harness.workspace.updateFileContent).not.toHaveBeenCalled();
    expect(consoleLines()).toEqual(panel.format.formattedLines);
  });

  it.each(FORMAT_CASES)(
    "$kind: formats from the button straight into the workspace",
    async (panel) => {
      setFiles({ [panel.entry]: SOURCE });
      formatEveryFile();
      await renderPanel(panel);

      await click(screen.getByRole("button", { name: "Format" }));

      expect(harness.workspace.updateFileContent).toHaveBeenCalledWith(panel.entry, FORMATTED);
      expect(consoleLines()).toEqual(panel.format.formattedLines);
    },
  );

  it.each(FORMAT_CASES)("$kind: shows the formatter while it works", async (panel) => {
    setFiles({ [panel.entry]: SOURCE });
    await renderPanel(panel);

    await click(screen.getByRole("button", { name: "Format" }));

    expect(screen.getByText(panel.format.command, { selector: "p" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(panel.format.busyLabel);
  });

  it.each(FORMAT_CASES)("$kind: says how a format ended", async (panel) => {
    setFiles({ [panel.entry]: SOURCE });
    formatEveryFile();
    await renderPanel(panel);

    await click(screen.getByRole("button", { name: "Format" }));

    // The result line without its tag: "Formatted main.go".
    expect(screen.getByRole("status").textContent).toBe(
      panel.format.formattedLines.at(-1)!.replace(/^\[[^\]]+\] /, ""),
    );
  });

  it.each(FORMAT_CASES)("$kind: refuses files the formatter cannot take", async (panel) => {
    setFiles(panel.format.refused.files);
    await renderPanel(panel);

    await click(screen.getByRole("button", { name: "Format" }));

    expect(consoleLines()).toEqual([panel.format.refused.line]);
    expect(harness.client.format).not.toHaveBeenCalled();
  });

  it.each(FORMAT_CASES)("$kind: will not format a read-only shared lesson", async (panel) => {
    setFiles({ [panel.entry]: SOURCE });
    harness.state.collaboration = { provider: {}, canWrite: false };
    await renderPanel(panel);

    expect(screen.getByRole("button", { name: "Format" })).toBeDisabled();
    await act(async () => {
      await activeProviders()[0].provide(
        model(panel.entry, SOURCE),
        {},
        {
          isCancellationRequested: false,
        },
      );
    });
    expect(consoleLines()).toEqual([panel.format.readOnlyLine]);
  });

  it.each(FORMAT_CASES)("$kind: formats signed out", async (panel) => {
    setFiles({ [panel.entry]: SOURCE });
    formatEveryFile();
    harness.state.auth = { isSignedIn: false, isLoading: false };
    await renderPanel(panel);

    await act(async () => {
      await activeProviders()[0].provide(
        model(panel.entry, SOURCE),
        {},
        {
          isCancellationRequested: false,
        },
      );
    });

    expect(harness.client.format).toHaveBeenCalledTimes(1);
    expect(consoleLines()).toEqual(panel.format.formattedLines);
  });

  it("zig: tells a build.zig.zon model it is not the lesson file rather than stale", async () => {
    const zig = CASES.find((panel) => panel.kind === "zig-playground")!;
    setFiles({ "main.zig": SOURCE, "build.zig.zon": ".{}\n" });
    await renderPanel(zig);

    await act(async () => {
      await activeProviders()[0].provide(
        model("build.zig.zon", ".{}\n"),
        {},
        {
          isCancellationRequested: false,
        },
      );
    });

    expect(consoleLines()).toEqual(["[zig-fmt error] Zig lessons format a single main.zig file"]);
  });

  it("go: calls a model that no longer matches the workspace stale", async () => {
    const [go] = CASES;
    setFiles({ "main.go": SOURCE });
    await renderPanel(go);

    await act(async () => {
      await activeProviders()[0].provide(
        model("main.go", "edited\n"),
        {},
        {
          isCancellationRequested: false,
        },
      );
    });

    expect(consoleLines()).toEqual([
      "[gofmt error] Files changed while formatting; no formatting was applied",
    ]);
    expect(harness.client.format).not.toHaveBeenCalled();
  });

  it.each(CASES)("$kind: replays the recorded dock during playback", async (panel) => {
    setFiles({ [panel.entry]: SOURCE });
    harness.state.metadata = {
      isPlaying: true,
      isRecording: false,
      currentRecording: {
        runtimeSnapshot: {
          mode: "single-file",
          status: "idle",
          activeTab: "runner",
          isFullHeight: true,
          consoleLines: ["recorded output"],
          terminalScrollLines: { [panel.surface]: 4 },
        },
      },
    };
    const { container } = await renderPanel(panel);

    expect(container.firstElementChild).toHaveClass("min-h-0", "flex-1");
    expect(screen.getByTestId("console")).toHaveTextContent("recorded output");
    expect(screen.getByTestId("console")).toHaveAttribute("data-scroll-line", "4");
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    expect(screen.getByRole("button", { name: panel.runnerTab })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^sign in/i })).toBeNull();
  });

  it.each(CASES)("$kind: stops a pending run when playback takes over", async (panel) => {
    setFiles({ [panel.entry]: SOURCE });
    let finishRun: (result: unknown) => void = () => {};
    harness.client.run.mockReturnValue(new Promise((resolve) => (finishRun = resolve)));
    await renderPanel(panel);
    await click(screen.getByRole("button", { name: "Run" }));
    expect(harness.client.stop).not.toHaveBeenCalled();

    harness.state.metadata = {
      isPlaying: true,
      isRecording: false,
      currentRecording: { runtimeSnapshot: { mode: "single-file", status: "idle" } },
    };
    act(() => harness.reactive.notify());
    await act(async () => finishRun(panel.run.result));

    expect(harness.client.stop).toHaveBeenCalledTimes(1);
    // The stopped run's result never reaches the console.
    expect(consoleLines()).toEqual(panel.run.lines.slice(0, 1));
  });

  it.each(CASES)("$kind: clears its console and forgets where it was scrolled", async (panel) => {
    setFiles({ [panel.entry]: SOURCE });
    await renderPanel(panel);
    act(() => {
      store.trigger.setConsoleLines({ consoleLines: ["output"] });
      store.trigger.setTerminalScrollLines({
        terminalScrollLines: { [panel.surface]: 12, "other-runner": 3 },
      });
    });

    await click(screen.getByRole("button", { name: "Clear" }));

    expect(consoleLines()).toEqual([]);
    expect(store.getSnapshot().context.terminalScrollLines).toEqual({ "other-runner": 3 });
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });
});

describe("playground runner languages", () => {
  it.each(CASES)("$kind: agrees with the studio on its dock", (panel) => {
    expect(panel.language.dockTargetId).toBe(dockTargetIdForRuntime(panel.kind));
    expect(panel.language.scrollSurface).toBe(panel.surface);
  });
});
