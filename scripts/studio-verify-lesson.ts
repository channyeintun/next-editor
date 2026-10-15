/**
 * Studio verify-lesson — replay a WebContainer (Vite) LessonScript against a
 * real Vite dev server and a real Chrome, the way /studio performs it, before
 * paying for narration (docs/lesson-script-authoring.md "Workflow").
 *
 *   bun scripts/studio-verify-lesson.ts src/studio/scripts/<slug>.yaml [...more]
 *       [--only-scene=<id>] [--speed=<factor>] [--viewport=432x720] [--bail]
 *       [--keep] [--headed] [--verbose] [--json=<out.json>] [--screenshot-dir=<dir>]
 *
 * Every action runs in plan order through the Performer's own dispatch
 * (invokeAction) into a local StudioDriver, with the planned times ignored.
 * `editor.type` writes each typing chunk to disk as the studio types it, so
 * half-typed JSX in a live module shows up the way a learner would see it: as
 * a Vite overlay or a console error. `preview.*` commands and
 * `expect.preview` go through the studio's real preview bridge, and
 * `expect.file` checks the typed workspace. Pointer, slides, whiteboard and
 * console runs are skipped. `--speed=2` types twice as fast, never closer than
 * 90 ms a chunk; `--only-scene` types every earlier scene at once.
 *
 * Fidelity, all reused from src/:
 *  - Parsed with parseLessonScript and compiled with the studio's compiler
 *    (script/estimatedCompile.ts, the registry test's estimate), so action
 *    order and the seeded typing chunks are the render's.
 *  - Anchors resolve with the driver's resolveAnchorOffset and chunks land with
 *    cadence.chunkPlacements; driver errors keep the driver's wording.
 *  - The preview runs in a cross-origin iframe with the exact script the
 *    WebContainer injects into every HTML response (createRuntimePreviewScript:
 *    console bridge, studio command bridge, rrweb recorder …).
 *  - The studio batches typed edits into the container every 75 ms
 *    (WEBCONTAINER_FILE_SYNC_WINDOW_MS); writing each chunk at least 90 ms
 *    apart lets Vite see every state the studio could have flushed.
 *
 * Fails a lesson on any console.error, uncaught error, unhandled rejection,
 * Vite overlay, Vite server error, failed resource load or failed action, and
 * exits 1 when any lesson failed. A pass is a preflight, not a render: the
 * real-Chrome render in /studio is still the gate.
 *
 * Needs system Chrome (playwright-core, channel "chrome"), node (the
 * workspace's own vite binary runs on it), and network the first time a
 * dependency set is seen: `bun install` of the pinned package.json into
 * node_modules/.cache/studio-verify-lesson/<hash>, cloned into each run.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Page,
} from "playwright-core";
import YAML from "yaml";

import {
  RRWEB_RECORDER_BUNDLE_MODULE_ID,
  loadRrwebRecorderBundle,
} from "../build/rrwebRecorderBundlePlugin.ts";
import { StudioActionError, resolveAnchorOffset } from "../src/studio/async.ts";
import { chunkPlacements } from "../src/studio/cadence.ts";
import type { StudioDriver } from "../src/studio/driver/index.ts";
import {
  PREVIEW_HANDSHAKE_PING_TIMEOUT_MS,
  PREVIEW_HANDSHAKE_RETRY_INTERVAL_MS,
} from "../src/studio/driver/webContainer.ts";
import { invokeAction } from "../src/studio/performer.ts";
import type { StudioPlanAction } from "../src/studio/plan.ts";
import {
  previewCommandTarget,
  previewExpectationMismatches,
} from "../src/studio/previewExpectation.ts";
import {
  compileWithEstimatedNarration,
  estimateByTokens,
} from "../src/studio/script/estimatedCompile.ts";
import { parseLessonScript, type LessonScript } from "../src/studio/script/schema.ts";
import {
  IFRAME_CONSOLE_MESSAGE_TYPE,
  formatPreviewConsoleLine,
} from "../src/utils/iframeConsoleBridge.ts";
import {
  STUDIO_PREVIEW_COMMAND_MESSAGE_TYPE,
  STUDIO_PREVIEW_COMMAND_RESPONSE_MESSAGE_TYPE,
  type StudioPreviewCommand,
  type StudioPreviewCommandResult,
} from "../src/utils/iframeStudioCommandBridge.ts";

// createRuntimePreviewScript embeds the rrweb recorder through a Vite virtual
// module (build/rrwebRecorderBundlePlugin.ts). Bun gets the same module from a
// runtime plugin, registered before the preview script is imported.
interface BunRuntime {
  plugin(plugin: {
    name: string;
    setup(builder: {
      module(specifier: string, load: () => { contents: string; loader: "js" }): void;
    }): void;
  }): void;
}
const bun = (globalThis as { Bun?: BunRuntime }).Bun;
if (!bun) {
  console.error("studio-verify-lesson: run it with bun — bun scripts/studio-verify-lesson.ts …");
  process.exit(2);
}
bun.plugin({
  name: "rrweb-recorder-bundle",
  setup(builder) {
    builder.module(RRWEB_RECORDER_BUNDLE_MODULE_ID, () => ({
      contents: `export default ${JSON.stringify(loadRrwebRecorderBundle().code)};`,
      loader: "js",
    }));
  },
});
const { createRuntimePreviewScript } = await import("../src/runtime/webcontainer/previewScript.ts");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** One installed node_modules per distinct dependency set, reused across runs. */
const depsCacheDir = join(repoRoot, "node_modules", ".cache", "studio-verify-lesson");
const MIN_CHUNK_GAP_MS = 90;

// ---------------------------------------------------------------- CLI
interface Options {
  lessonPaths: string[];
  keep: boolean;
  headed: boolean;
  onlyScene: string | null;
  speed: number;
  viewport: { width: number; height: number };
  bail: boolean;
  verbose: boolean;
  json: string | null;
  screenshotDir: string | null;
}

function usage(message: string): never {
  console.error(`studio-verify-lesson: ${message}
usage: bun scripts/studio-verify-lesson.ts <lesson.yaml> [...more]
         [--only-scene=<id>] [--speed=<factor>] [--viewport=432x720] [--bail]
         [--keep] [--headed] [--verbose] [--json=<out.json>] [--screenshot-dir=<dir>]`);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    lessonPaths: [],
    keep: false,
    headed: false,
    onlyScene: null,
    speed: 1,
    viewport: { width: 432, height: 720 },
    bail: false,
    verbose: false,
    json: null,
    screenshotDir: null,
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      options.lessonPaths.push(resolve(arg));
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const value = equals === -1 ? "" : arg.slice(equals + 1);
    const required = () => {
      if (!value) usage(`${flag} needs a value: ${flag}=…`);
      return value;
    };
    switch (flag) {
      case "--keep":
        options.keep = true;
        break;
      case "--headed":
        options.headed = true;
        break;
      case "--bail":
        options.bail = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--only-scene":
        options.onlyScene = required();
        break;
      case "--speed":
        options.speed = Number(required());
        if (!(options.speed > 0)) usage("--speed must be > 0");
        break;
      case "--viewport": {
        const match = /^(\d+)x(\d+)$/.exec(required());
        if (!match) usage("--viewport must be WxH, e.g. --viewport=432x720");
        options.viewport = { width: Number(match[1]), height: Number(match[2]) };
        break;
      }
      case "--json":
        options.json = resolve(required());
        break;
      case "--screenshot-dir":
        options.screenshotDir = resolve(required());
        break;
      default:
        usage(`unknown flag ${arg}`);
    }
  }
  if (options.lessonPaths.length === 0) usage("name at least one lesson YAML");
  return options;
}

// ---------------------------------------------------------------- utilities
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const now = () => performance.now();
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const clip = (text: string, max = 160) => {
  const json = JSON.stringify(text);
  return json.length > max ? `${json.slice(0, max - 1)}…"` : json;
};
/**
 * `promise`, or `fallback` once `ms` pass. Playwright's frame calls wait for
 * the frame's next document with no timeout of their own, so one probe of a
 * preview caught between documents used to hang a whole run.
 */
function within<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((done, fail) => {
    timer = setTimeout(() => {
      try {
        done(fallback());
      } catch (error) {
        fail(error);
      }
    }, ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
const PROBE_TIMEOUT_MS = 1000;
const displayPath = (file: string) =>
  file.startsWith(`${repoRoot}/`) ? relative(repoRoot, file) : file;

async function freePort(): Promise<number> {
  return await new Promise((done, fail) => {
    const server = createNetServer();
    server.unref();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

// ---------------------------------------------------------------- workspace
interface PackageJson {
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
}

function ensureInstalled(packageJson: PackageJson, log: (line: string) => void): string {
  // The lesson's own initCommand (pnpm install, no lockfile) is replaced by a
  // cached bun install of the same dependency ranges.
  const dependencySet = {
    type: packageJson.type ?? "module",
    dependencies: packageJson.dependencies ?? {},
    devDependencies: packageJson.devDependencies ?? {},
    optionalDependencies: packageJson.optionalDependencies ?? {},
    overrides: packageJson.overrides ?? {},
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(dependencySet))
    .digest("hex")
    .slice(0, 16);
  const dir = join(depsCacheDir, hash);
  const marker = join(dir, "node_modules", ".verify-complete");
  if (existsSync(marker)) return dir;

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "studio-verify-lesson-deps", private: true, ...dependencySet }, null, 2),
  );
  log(`installing dependencies into ${displayPath(dir)} (bun install)…`);
  const started = now();
  const result = spawnSync("bun", ["install"], { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`bun install failed:\n${result.stdout}\n${result.stderr}`);
  }
  writeFileSync(marker, new Date().toISOString());
  log(`installed in ${Math.round(now() - started)}ms`);
  return dir;
}

function materializeWorkspace(files: Record<string, string>, cacheDir: string): string {
  // Outside the repo on purpose: Node and Vite resolve a bare import by walking
  // up parent directories, so a run inside the checkout would quietly find the
  // repo's own node_modules and hide a dependency the lesson forgot to pin.
  const dir = mkdtempSync(join(tmpdir(), "studio-verify-lesson-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  // An APFS clone (copy-on-write) is a real, private node_modules, so Vite's
  // optimizer cache (node_modules/.vite) starts empty as in a fresh WebContainer.
  const source = join(cacheDir, "node_modules");
  const target = join(dir, "node_modules");
  if (spawnSync("cp", ["-cR", source, target]).status !== 0) {
    const copied = spawnSync("cp", ["-R", source, target], { encoding: "utf8" });
    if (copied.status !== 0) throw new Error(`could not copy node_modules: ${copied.stderr}`);
  }
  return dir;
}

// ---------------------------------------------------------------- vite
interface ViteServer {
  url: string;
  child: ChildProcess;
}

function viteArgsFromScript(script: string, port: number): string[] {
  const tokens = script.trim().split(/\s+/);
  if (tokens[0] !== "vite") {
    throw new Error(
      `studio-verify-lesson only runs Vite dev scripts; found ${JSON.stringify(script)}`,
    );
  }
  const rest = tokens.slice(1).filter((token) => token !== "dev" && token !== "serve");
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "--port" || token === "--host") {
      i += 1;
      continue;
    }
    if (token.startsWith("--port=") || token.startsWith("--host=") || token === "--open") continue;
    args.push(token);
  }
  return [...args, "--host", "127.0.0.1", "--port", String(port), "--strictPort"];
}

type WebContainerRuntime = Extract<LessonScript["runtime"], { kind: "webcontainer" }>;

async function startVite(
  dir: string,
  runtime: WebContainerRuntime,
  packageJson: PackageJson,
  onLine: (line: string) => void,
): Promise<ViteServer> {
  const match = /^(?:pnpm(?: run)?|npm run|yarn(?: run)?|bun run)\s+(\S+)$/.exec(
    runtime.runCommand.trim(),
  );
  const devScript = match ? packageJson.scripts?.[match[1]] : runtime.runCommand;
  if (typeof devScript !== "string") {
    throw new Error(
      `runCommand ${JSON.stringify(runtime.runCommand)} names no package.json script`,
    );
  }
  const viteBin = join(dir, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) throw new Error("the workspace's package.json installs no vite");
  const port = await freePort();
  const child = spawn("node", [viteBin, ...viteArgsFromScript(devScript, port)], {
    cwd: dir,
    env: {
      ...process.env,
      ...runtime.environment,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      BROWSER: "none",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const feed = (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      lines.push(line);
      onLine(line);
    }
  };
  child.stdout?.on("data", feed);
  child.stderr?.on("data", feed);
  const url = `http://127.0.0.1:${port}/`;
  const deadline = now() + 60_000;
  while (now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`vite exited with ${child.exitCode}:\n${lines.join("\n")}`);
    }
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return { url, child };
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  child.kill("SIGKILL");
  throw new Error(`vite did not answer on ${url} within 60s:\n${lines.join("\n")}`);
}

// ---------------------------------------------------------------- browser
const EVENT_BINDING = "__verifyLessonEvent";

/**
 * One Chrome for the whole run, a fresh context per lesson. Under bun 1.3, a
 * second Chrome that Playwright launches in the same process loses its
 * DevTools pipe at the next garbage collection once the first has closed —
 * Chrome logs "Connection terminated while reading from pipe" and every call
 * stalls — so the browser is launched once and closed at exit.
 */
let browserLaunch: Promise<Browser> | null = null;
function sharedBrowser(headed: boolean): Promise<Browser> {
  browserLaunch ??= chromium.launch({ channel: "chrome", headless: !headed });
  return browserLaunch;
}
async function closeSharedBrowser(): Promise<void> {
  if (browserLaunch) await (await browserLaunch).close().catch(() => undefined);
}

type FrameEvent =
  | { kind: "boot" | "load"; href: string }
  | { kind: "uncaught-exception" | "unhandled-rejection" | "overlay"; text: string }
  | { kind: "console"; method: string; args: string[]; pathname: string };

/**
 * Runs in every frame; only the preview iframe — not the host page — gets the
 * studio's preview script plus the error, overlay and boot probes.
 */
function frameInitScript(previewScript: string): string {
  return `(() => {
    if (window === window.top || !/^https?:$/.test(location.protocol)) return;
    const report = (kind, data) => { try { window.${EVENT_BINDING}({ kind, ...data }); } catch {} };
    report("boot", { href: location.href });
    window.addEventListener("load", () => report("load", { href: location.href }));
    window.addEventListener("error", (event) => {
      const error = event.error;
      report("uncaught-exception", { text: (error && (error.stack || error.message)) || event.message || "Script error" });
    });
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      report("unhandled-rejection", { text: (reason && (reason.stack || reason.message)) || String(reason) });
    });
    const seen = new WeakSet();
    const scan = () => {
      for (const element of document.querySelectorAll("vite-error-overlay")) {
        if (seen.has(element)) continue;
        seen.add(element);
        queueMicrotask(() => {
          const root = element.shadowRoot;
          const text = root ? (root.querySelector(".message-body")?.textContent || root.textContent || "") : element.textContent || "";
          report("overlay", { text: text.trim().slice(0, 2000) });
        });
      }
    };
    new MutationObserver(scan).observe(document, { childList: true, subtree: true });
    ${previewScript}
  })();`;
}

/**
 * The studio's side of the bridge: the preview in a cross-origin iframe,
 * console lines relayed to the run, and commands posted with correlated ids
 * the way utils/previewFrameRequest.ts posts them.
 */
function hostPageHtml(previewUrl: string, viewport: { width: number; height: number }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>studio-verify-lesson</title>
<style>html,body{margin:0;background:#222}iframe{border:0;display:block;width:${viewport.width}px;height:${viewport.height}px;background:white}</style></head>
<body><iframe id="preview" src="${previewUrl}"></iframe>
<script>
  const REQUEST = ${JSON.stringify(STUDIO_PREVIEW_COMMAND_MESSAGE_TYPE)};
  const RESPONSE = ${JSON.stringify(STUDIO_PREVIEW_COMMAND_RESPONSE_MESSAGE_TYPE)};
  const CONSOLE = ${JSON.stringify(IFRAME_CONSOLE_MESSAGE_TYPE)};
  const frame = document.getElementById("preview");
  let counter = 0;
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (data && data.type === CONSOLE && data.payload) {
      try { window.${EVENT_BINDING}({ kind: "console", method: data.payload.method, args: data.payload.args, pathname: data.payload.pathname }); } catch {}
    }
  });
  window.__studioCommand = (command, timeoutMs) => new Promise((resolve, reject) => {
    const id = "studio-preview-" + (++counter);
    const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", onMessage); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Preview command timed out after " + timeoutMs + "ms")); }, timeoutMs);
    function onMessage(event) {
      if (event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || data.type !== RESPONSE || !data.payload || data.payload.id !== id) return;
      cleanup();
      if (typeof data.payload.error === "string") reject(new Error(data.payload.error));
      else resolve(data.payload.result);
    }
    window.addEventListener("message", onMessage);
    try { frame.contentWindow.postMessage({ type: REQUEST, payload: { id, command } }, "*"); }
    catch (error) { cleanup(); reject(error); }
  });
</script></body></html>`;
}

// ---------------------------------------------------------------- one lesson
type Status = "ok" | "fail" | "skip";

interface ActionReport {
  id: string;
  type: string;
  scene: string;
  status: Status;
  ms: number;
  notes: string[];
}

interface Failure {
  actionId: string;
  kind: string;
  message: string;
  intermediate?: string;
}

interface LessonResult {
  file: string;
  slug: string;
  pass: boolean;
  failures: Failure[];
  reports: ActionReport[];
  counters: { boots: number; loads: number; hmr: number; viteReloads: number; warns: number };
  eventLog: string[];
}

/** The Performer's retry rule (performer.ts): only actions that declare `retry` try again. */
async function withRetry<T>(action: StudioPlanAction, attempt: () => Promise<T>): Promise<T> {
  const retry = "retry" in action ? action.retry : { maxAttempts: 1, delayMs: 0 };
  let lastError: unknown;
  for (let attemptNumber = 1; attemptNumber <= retry.maxAttempts; attemptNumber++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (attemptNumber < retry.maxAttempts) await sleep(retry.delayMs);
    }
  }
  throw lastError;
}

async function verifyLesson(lessonPath: string, options: Options): Promise<LessonResult> {
  const log = (line: string) => console.log(line);
  const started = now();
  const file = displayPath(lessonPath);
  const failures: Failure[] = [];
  const reports: ActionReport[] = [];
  const counters = { boots: 0, loads: 0, hmr: 0, viteReloads: 0, warns: 0 };
  const eventLog: string[] = [];
  const result = (slug: string): LessonResult => ({
    file,
    slug,
    pass: failures.length === 0,
    failures,
    reports,
    counters,
    eventLog,
  });

  let script: LessonScript;
  let plan: ReturnType<typeof compileWithEstimatedNarration>["plan"];
  let warnings: string[];
  try {
    script = parseLessonScript(YAML.parse(readFileSync(lessonPath, "utf8")));
    ({ plan, warnings } = compileWithEstimatedNarration(script, estimateByTokens));
  } catch (error) {
    log(`\n✗ ${file}: parse/compile failed: ${messageOf(error)}`);
    failures.push({ actionId: "(compile)", kind: "compile", message: messageOf(error) });
    return result(file);
  }
  const slug = script.lesson.slug;
  log(`\n▶ ${slug} — ${script.lesson.title} (${file})`);
  log(`  ${plan.actions.length} plan actions, seed ${script.build.seed}`);
  for (const warning of warnings) log(`  ⚠ compile: ${warning}`);

  const { runtime } = script;
  if (runtime.kind !== "webcontainer") {
    log(
      `  ✗ studio-verify-lesson replays webcontainer (Vite) lessons; this one is ${runtime.kind}`,
    );
    failures.push({ actionId: "(runtime)", kind: "runtime", message: runtime.kind });
    return result(slug);
  }
  const webContainer: WebContainerRuntime = runtime;
  const sceneIndex = new Map(script.scenes.map((scene, index) => [scene.id, index]));
  if (options.onlyScene !== null && !sceneIndex.has(options.onlyScene)) {
    log(`  ✗ --only-scene=${options.onlyScene}: this lesson has no such scene`);
    failures.push({ actionId: "(options)", kind: "options", message: "no such scene" });
    return result(slug);
  }
  // Authored actions name their scene. The compiler's own (a pointer move, a
  // dock expand) serve the authored action after them, so they take its scene.
  const authoredScene = new Map<string, string>();
  for (const scene of script.scenes) {
    for (const action of scene.actions) authoredScene.set(action.id, scene.id);
  }
  const sceneOf = new Map<string, string>();
  let nextScene = "?";
  for (const action of [...plan.actions].reverse()) {
    nextScene = authoredScene.get(action.id) ?? nextScene;
    sceneOf.set(action.id, nextScene);
  }

  // ---- workspace
  const files: Record<string, string> = { ...script.lesson.workspace.files };
  const packageJsonText = files["package.json"];
  if (packageJsonText === undefined) {
    log("  ✗ the workspace pins no package.json");
    failures.push({ actionId: "(workspace)", kind: "workspace", message: "no package.json" });
    return result(slug);
  }
  const packageJson = JSON.parse(packageJsonText) as PackageJson;
  let workdir: string;
  try {
    workdir = materializeWorkspace(
      files,
      ensureInstalled(packageJson, (line) => log(`  ${line}`)),
    );
  } catch (error) {
    log(`  ✗ ${messageOf(error)}`);
    failures.push({ actionId: "(workspace)", kind: "workspace", message: messageOf(error) });
    return result(slug);
  }
  log(`  workspace ${workdir}`);

  let lastWriteAt = 0;
  let loadDelays: number[] = [];
  const writeWorkspaceFile = (path: string, content: string) => {
    files[path] = content;
    const target = join(workdir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    lastWriteAt = now();
  };

  let activeFile = script.lesson.workspace.entryFilePath;
  let server: ViteServer | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let previewFrame: Frame | null = null;
  let hostServer: Server | null = null;
  const previewScript = createRuntimePreviewScript();

  // Attribution: which action, and which typed state, is current when an
  // asynchronous error lands.
  let phase: { actionId: string; detail?: string } = { actionId: "(startup)" };
  let lastActivity = now();
  const touch = () => {
    lastActivity = now();
  };

  const printedFailureKeys = new Set<string>();
  const recordFailure = (kind: string, message: string) => {
    const failure: Failure = {
      actionId: phase.actionId,
      kind,
      message,
      intermediate: phase.detail,
    };
    failures.push(failure);
    // Print the first failure of each (action, kind) live; the summary counts the rest.
    const key = `${failure.actionId}\u0000${kind}`;
    if (printedFailureKeys.has(key) && !options.verbose) return;
    printedFailureKeys.add(key);
    const where = failure.intermediate ? ` @ ${failure.intermediate}` : "";
    const body = message.split("\n").slice(0, 6).join("\n      ");
    log(`    ✗ [${kind}] during ${failure.actionId}${where}\n      ${body}`);
  };

  const onFrameEvent = (event: FrameEvent) => {
    touch();
    switch (event.kind) {
      case "boot":
        counters.boots += 1;
        eventLog.push(`${Math.round(now() - started)}ms boot ${event.href}`);
        break;
      case "load":
        counters.loads += 1;
        if (lastWriteAt > 0) loadDelays.push(Math.round(now() - lastWriteAt));
        break;
      case "uncaught-exception":
      case "unhandled-rejection":
        recordFailure(event.kind, `[preview:error] ${event.text}`);
        break;
      case "overlay":
        recordFailure("vite-overlay", event.text || "(vite-error-overlay shown)");
        break;
      case "console": {
        const text = event.args.join(" ");
        const line = formatPreviewConsoleLine(event.method, event.pathname, text);
        if (event.method === "error") recordFailure("console.error", line);
        else if (event.method === "warn") {
          counters.warns += 1;
          log(`    · ${line.slice(0, 300)}`);
        } else if (/\[vite\] hot updated/.test(text)) counters.hmr += 1;
        else if (options.verbose) log(`    · ${line.slice(0, 300)}`);
        break;
      }
    }
  };

  const onViteLine = (line: string) => {
    touch();
    if (/page reload/i.test(line)) counters.viteReloads += 1;
    if (
      /internal server error|pre-transform error|\[ERROR\]|^\s*Error:|error while updating dependencies|failed to (load|resolve|scan)/i.test(
        line,
      )
    ) {
      recordFailure("vite-server", line);
    } else if (
      options.verbose ||
      /new dependencies|optimized dependencies changed|reloading/i.test(line)
    ) {
      log(`    vite: ${line}`);
    }
  };

  async function ensureServer(): Promise<ViteServer> {
    if (server) return server;
    const startedAt = now();
    server = await startVite(workdir, webContainer, packageJson, onViteLine);
    log(`    vite ready at ${server.url} in ${Math.round(now() - startedAt)}ms`);
    return server;
  }

  async function studioCommand(
    command: StudioPreviewCommand,
    timeoutMs: number,
  ): Promise<StudioPreviewCommandResult> {
    if (!page) throw new StudioActionError("The live preview iframe is not available");
    const ms = Math.max(1, Math.round(timeoutMs));
    // The host page times the command out itself; the outer limit only
    // covers a host page that stopped answering.
    const answer = page.evaluate(
      ([cmd, limit]) =>
        (
          window as unknown as {
            __studioCommand(command: unknown, timeoutMs: number): Promise<unknown>;
          }
        ).__studioCommand(cmd, limit),
      [command, ms] as const,
    );
    return (await within(answer, ms + PROBE_TIMEOUT_MS, () => {
      throw new Error(`Preview command timed out after ${ms}ms`);
    })) as StudioPreviewCommandResult;
  }

  async function launchPreview(previewUrl: string) {
    const browser = await sharedBrowser(options.headed);
    context = await browser.newContext({
      viewport: { width: options.viewport.width + 40, height: options.viewport.height + 40 },
    });
    await context.exposeBinding(EVENT_BINDING, (_source, event: FrameEvent) => onFrameEvent(event));
    await context.addInitScript({ content: frameInitScript(previewScript) });
    page = await context.newPage();
    page.on("console", (message) => {
      // Browser-generated errors (a failed module or resource load) never pass
      // through console.error, so the studio bridge never sees them — but they
      // mean the preview is broken. Bridged console.error lines arrive above.
      if (message.type() !== "error") return;
      const text = message.text();
      if (/^Failed to load resource|net::ERR_/i.test(text)) {
        touch();
        recordFailure("browser", `${text} (${message.location().url})`);
      }
    });
    page.on("request", touch);
    page.on("requestfinished", touch);
    page.on("requestfailed", touch);
    page.on("framenavigated", touch);
    const html = hostPageHtml(previewUrl, options.viewport);
    const host = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
    });
    hostServer = host;
    await new Promise<void>((done) => host.listen(0, "127.0.0.1", done));
    const address = host.address();
    const hostPort = typeof address === "object" && address ? address.port : 0;
    await page.goto(`http://127.0.0.1:${hostPort}/`);
    previewFrame = (await (await page.$("#preview"))?.contentFrame()) ?? null;
  }

  /** Wait until the preview has been quiet: no requests, navigations or events. */
  async function settle(quietMs = 700, maxMs = 15_000) {
    const until = now() + maxMs;
    await sleep(150); // let the watcher notice the last write
    while (now() < until) {
      if (now() - Math.max(lastActivity, lastWriteAt) >= quietMs) {
        if (!previewFrame) return;
        try {
          const readyState = await within(
            previewFrame.evaluate(() => document.readyState),
            PROBE_TIMEOUT_MS,
            () => "loading",
          );
          if (readyState === "complete") return;
        } catch {
          // The frame is navigating; keep waiting.
        }
      }
      await sleep(50);
    }
  }

  async function overlayCheck() {
    if (!previewFrame) return;
    try {
      const present = await within(
        previewFrame.evaluate(() => document.querySelector("vite-error-overlay") !== null),
        PROBE_TIMEOUT_MS,
        () => false,
      );
      const reported = failures.some(
        (failure) => failure.kind === "vite-overlay" && failure.actionId === phase.actionId,
      );
      if (present && !reported) recordFailure("vite-overlay", "a vite-error-overlay is on screen");
    } catch {
      // The frame is navigating; the next check sees the settled page.
    }
  }

  async function screenshot(name: string): Promise<string | null> {
    if (!options.screenshotDir || !page) return null;
    mkdirSync(options.screenshotDir, { recursive: true });
    const path = join(options.screenshotDir, `${slug}-${name}.png`);
    await page.screenshot({ path }).catch(() => undefined);
    return path;
  }

  // ---- the local driver: one command per StudioDriver method
  let current: ActionReport = { id: "", type: "", scene: "", status: "ok", ms: 0, notes: [] };
  let fastForward = false;
  const note = (text: string) => current.notes.push(text);
  const skip = (reason: string) => {
    current.status = "skip";
    note(reason);
    return { skipped: reason };
  };
  const requireActive = (path: string) => {
    if (activeFile !== path) {
      throw new StudioActionError(
        `The active editor shows "${activeFile}" but the action targets "${path}"`,
      );
    }
  };

  const driver: StudioDriver = {
    async openFile(path) {
      if (!Object.hasOwn(files, path))
        throw new StudioActionError(`Workspace has no file "${path}"`);
      activeFile = path;
      note(path);
      return { path };
    },

    async typeText({ path, anchor, chunks }) {
      requireActive(path);
      const content = files[path];
      const startOffset = resolveAnchorOffset(content, anchor);
      if (startOffset === null) {
        throw new StudioActionError(
          `Anchor occurrence ${anchor.occurrence} of ${JSON.stringify(anchor.after)} not found in "${path}"`,
        );
      }
      const { relativeOffsets, expectedText } = chunkPlacements(chunks);
      const live = server !== null && !fastForward;
      note(
        `${path} +${expectedText.length} chars in ${chunks.length} chunk(s)${live ? " (live)" : ""}`,
      );
      if (!live) {
        writeWorkspaceFile(
          path,
          content.slice(0, startOffset) + expectedText + content.slice(startOffset),
        );
        if (server) await settle();
        return { path, typed: expectedText.length };
      }
      let typed = content;
      let typedLength = 0;
      for (const [index, chunk] of chunks.entries()) {
        await sleep(Math.max(MIN_CHUNK_GAP_MS, chunk.delayMs / options.speed));
        const at = startOffset + relativeOffsets[index];
        typed = typed.slice(0, at) + chunk.text + typed.slice(at);
        typedLength += chunk.text.length;
        // Chunks always land inside the span typed so far, so it stays contiguous.
        const soFar = clip(typed.slice(startOffset, startOffset + typedLength), 120);
        phase = {
          actionId: phase.actionId,
          detail: `chunk ${index + 1}/${chunks.length}, typed so far ${soFar}`,
        };
        writeWorkspaceFile(path, typed);
      }
      if (typed.slice(startOffset, startOffset + expectedText.length) !== expectedText) {
        throw new StudioActionError(`Typed content diverged in "${path}"`);
      }
      phase = { actionId: phase.actionId, detail: "after typing settled" };
      await settle();
      return { path, typed: expectedText.length };
    },

    async selectRange({ path, selection }) {
      requireActive(path);
      const end = resolveAnchorOffset(files[path], {
        after: selection.text,
        occurrence: selection.occurrence,
      });
      if (end === null) {
        throw new StudioActionError(
          `Selection occurrence ${selection.occurrence} of ${JSON.stringify(selection.text)} not found in "${path}"`,
        );
      }
      note(`${path} ${clip(selection.text, 60)}`);
      return { path };
    },

    async startRuntime() {
      return { url: (await ensureServer()).url };
    },

    async waitForRuntimeReady() {
      const { url } = await ensureServer();
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (!response?.ok) throw new StudioActionError(`The dev server at ${url} is not ready`);
      return { url };
    },

    async openPreview({ mode, timeoutMs }) {
      if (!server) {
        throw new StudioActionError("preview.open before runtime.start: no server is running");
      }
      if (!page) await launchPreview(server.url);
      // The studio's handshake: knock with short pings until the injected
      // bridge answers, all inside the one action budget.
      const deadline = now() + timeoutMs;
      let lastError: unknown = null;
      while (now() < deadline) {
        try {
          const { route } = await studioCommand(
            { type: "ping" },
            Math.min(PREVIEW_HANDSHAKE_PING_TIMEOUT_MS, deadline - now()),
          );
          note(`route ${route}`);
          await settle();
          return { mode, bridge: "ready", route };
        } catch (error) {
          lastError = error;
          await sleep(PREVIEW_HANDSHAKE_RETRY_INTERVAL_MS);
        }
      }
      throw new StudioActionError(
        `Preview iframe did not become ready within ${timeoutMs}ms: ${messageOf(lastError)}`,
      );
    },

    async executePreviewCommand({ command, timeoutMs }) {
      let acknowledgement: StudioPreviewCommandResult;
      try {
        acknowledgement = await studioCommand(command, timeoutMs);
      } catch (error) {
        throw new StudioActionError(`Preview ${command.type} command failed: ${messageOf(error)}`);
      }
      if (command.type === "route") note(command.route);
      else if ("target" in command && command.target) note(command.target.testId);
      // Let the preview react (a re-render, a navigation) before the next action.
      await sleep(120);
      return { acknowledgement };
    },

    async expectPreview({ actionId, target, textContains, value, route, attribute, timeoutMs }) {
      const inspection = await studioCommand(
        { type: "inspect", target: previewCommandTarget(target) },
        timeoutMs,
      );
      const mismatches = previewExpectationMismatches(
        { route, textContains, value, attribute },
        inspection,
      );
      if (mismatches.length > 0) {
        const observed = inspection.target
          ? `; observed text ${clip(inspection.target.text, 200)}`
          : "";
        const shot = await screenshot(actionId);
        if (shot) note(`screenshot ${shot}`);
        throw new StudioActionError(
          `Preview expectation failed: ${mismatches.join("; ")}${observed}`,
        );
      }
      const parts = [
        target?.value ?? "",
        textContains !== undefined ? `⊇ ${clip(textContains, 50)}` : "",
        value !== undefined ? `value=${clip(value, 40)}` : "",
        attribute ? `[${attribute.name}=${attribute.value}]` : "",
        route ? `route=${route}` : "",
      ];
      note(parts.filter(Boolean).join(" "));
      return { inspection };
    },

    async expectFile({ path, contains }) {
      const content = files[path];
      if (content === undefined)
        throw new StudioActionError(`Workspace has no text file "${path}"`);
      if (!content.includes(contains)) {
        throw new StudioActionError(`File "${path}" does not contain ${JSON.stringify(contains)}`);
      }
      return { path };
    },

    // Not this verifier's concern: the render's own gates check these.
    moveCursor: async () => skip("pointer moves are not checked"),
    pointConsole: async () => skip("console actions are not checked"),
    runWorkspace: async () => skip("console runs are not checked"),
    waitForOutput: async () => skip("console output is not checked"),
    collapseRuntimeDock: async () => skip("dock state is not checked"),
    expandRuntimeDock: async () => skip("dock state is not checked"),
    showSlide: async () => skip("slides are not checked"),
    closeSlide: async () => skip("slides are not checked"),
    applyWhiteboard: async () => skip("the whiteboard is not checked"),
  };

  // ---- walk the plan in the studio's order
  const onlyScene = options.onlyScene;
  const onlySceneIndex = onlyScene === null ? -1 : (sceneIndex.get(onlyScene) ?? -1);
  try {
    for (const action of plan.actions) {
      const scene = sceneOf.get(action.id) ?? "?";
      // --only-scene: earlier scenes fast-forward (typing lands at once), later ones never run.
      if (onlyScene !== null && (sceneIndex.get(scene) ?? -1) > onlySceneIndex) break;
      fastForward = onlyScene !== null && scene !== onlyScene;

      current = { id: action.id, type: action.type, scene, status: "ok", ms: 0, notes: [] };
      const failuresBefore = failures.length;
      const countersBefore = { ...counters };
      const startedAt = now();
      phase = { actionId: action.id };
      loadDelays = [];

      try {
        await withRetry(action, () => invokeAction(action, driver));
      } catch (error) {
        recordFailure("action", messageOf(error));
      }

      await overlayCheck();
      current.ms = Math.round(now() - startedAt);
      if (action.type === "editor.type" && server && previewFrame) {
        const reloads = counters.boots - countersBefore.boots;
        const hmr = counters.hmr - countersBefore.hmr;
        const delays = loadDelays.length
          ? ` (load ${Math.min(...loadDelays)}–${Math.max(...loadDelays)}ms after write)`
          : "";
        note(`${reloads} reload(s)${delays}, ${hmr} hmr update(s)`);
      }
      if (failures.length > failuresBefore) current.status = "fail";
      reports.push(current);
      if (current.status !== "skip" || options.verbose) {
        const mark = current.status === "ok" ? "✓" : current.status === "fail" ? "✗" : "·";
        log(
          `  ${mark} ${scene} › ${action.id} ${action.type} (${current.ms}ms) ${current.notes.join(" · ")}`,
        );
      }
      if (options.bail && failures.length > 0) break;
    }

    // A final quiet period: late errors still count.
    phase = { actionId: "(after last action)" };
    if (previewFrame) {
      await settle(800, 5000);
      await overlayCheck();
      const shot = await screenshot("final");
      if (shot) log(`  final preview screenshot ${shot}`);
    }
  } finally {
    await (context as BrowserContext | null)?.close().catch(() => undefined);
    (hostServer as Server | null)?.close();
    const vite = server as ViteServer | null;
    if (vite) {
      vite.child.kill("SIGTERM");
      await sleep(100);
      if (vite.child.exitCode === null) vite.child.kill("SIGKILL");
    }
    if (options.keep) log(`  kept workspace ${workdir}`);
    else rmSync(workdir, { recursive: true, force: true });
  }

  const count = (status: Status) => reports.filter((report) => report.status === status).length;
  const seconds = Math.round((now() - started) / 1000);
  log(
    `${failures.length > 0 ? "✗ FAIL" : "✓ PASS"} ${slug}: ${count("ok")} ok, ${count("fail")} failed, ${count("skip")} skipped; ${failures.length} failure(s); ${counters.boots} preview boot(s), ${counters.warns} console.warn; ${seconds}s`,
  );
  // One line per (action, kind): the FIRST offending state, plus how many more.
  const groups = new Map<string, Failure[]>();
  for (const failure of failures) {
    const key = `${failure.actionId}\u0000${failure.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), failure]);
  }
  for (const [first, ...rest] of groups.values()) {
    const more = rest.length > 0 ? ` ×${rest.length + 1}` : "";
    const where = first.intermediate ? ` first @ ${first.intermediate}` : "";
    log(
      `  - ${first.actionId} [${first.kind}]${more}${where}: ${first.message.split("\n")[0].slice(0, 400)}`,
    );
  }
  return result(slug);
}

// ---------------------------------------------------------------- main
const options = parseArgs(process.argv.slice(2));
const results: LessonResult[] = [];
for (const lessonPath of options.lessonPaths) {
  const lesson = await verifyLesson(lessonPath, options);
  results.push(lesson);
  if (options.bail && !lesson.pass) break;
}
await closeSharedBrowser();
if (options.json) writeFileSync(options.json, `${JSON.stringify(results, null, 2)}\n`);

const failed = results.filter((lesson) => !lesson.pass);
console.log(`\n${results.length - failed.length} of ${options.lessonPaths.length} lesson(s) pass.`);
if (failed.length > 0 || results.length < options.lessonPaths.length) {
  console.error(
    `\nstudio-verify-lesson: failed — ${failed.map((lesson) => lesson.slug).join(", ") || "stopped early"}`,
  );
  process.exit(1);
}
