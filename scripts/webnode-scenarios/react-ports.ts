// The React starter (TanStack Start with Nitro) announces two servers. The
// preview is opened the moment the dev server's port is announced, as the
// editor does, and must show the app from then on, never an error page; then
// each announced server is shown. Every step throws when it does not hold.
// TWO_ORIGINS=1 shows the first announced server before the dev server's.
import type { HarnessApi } from "../webnode-harness";

const DEV_PORT = 4173;
const TITLE = "TanStack Start | Type-Safe, Client-First, Full-Stack React";
const WELCOME = "Welcome to TanStack Start";

/** The files as a mount tree; a file that is not text (an asset) is left out. */
function tree(files: Record<string, { content?: unknown }>) {
  const root: any = {};
  for (const [path, file] of Object.entries(files)) {
    if (typeof file.content !== "string") continue;
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= { directory: {} }).directory;
    node[parts.at(-1)!] = { file: { contents: file.content } };
  }
  return root;
}

export default async function (api: HarnessApi) {
  const project = (await import("../../src/starters/react")).createStarterWorkspaceProject();
  await api.call("mount", tree(project.files));
  let t = Date.now();
  const install = await api.sh("pnpm install", { timeoutMs: 500000 });
  api.check(
    `pnpm install exits 0 (${Date.now() - t} ms)`,
    install.code === 0,
    `exit ${install.code}${install.timedOut ? ", timed out" : ""}: ${JSON.stringify(install.output.slice(-600))}`,
  );
  t = Date.now();
  const runner = await api.terminal("sh", ["-lc", "pnpm dev"]);
  if (process.env.TWO_ORIGINS) {
    const first = await api.server({ runner, timeoutMs: 40000 });
    console.log(`     [${Date.now() - t} ms] first server: ${first.port}`);
    if (first.port !== DEV_PORT) await api.preview(first.url);
  }
  const vite = await api.server({ port: DEV_PORT, runner, timeoutMs: 40000 });
  console.log(`     [${Date.now() - t} ms] port ${DEV_PORT} announced`);
  // Opened at once, and watched: an error page, even one that a reload would cure, fails.
  const preview = await api.preview(vite.url);
  let shown = 0;
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const view = await preview.read();
    if (view && (view.title !== "" || view.text !== "")) {
      shown += 1;
      if (view.title !== TITLE || view.overlay !== null || /error|unavailable/i.test(view.text)) {
        throw new Error(
          `opened at announce, the preview shows ${JSON.stringify({ ...view, text: view.text.slice(0, 300) })}`,
        );
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  api.check(
    "opened at announce, the preview never shows an error page",
    shown > 0,
    "it showed no document for 6 s",
  );
  await preview.expect(
    "and shows the app",
    (view) => view.title === TITLE && view.text.includes(WELCOME),
    10000,
  );
  if (process.env.RACE_ONLY) return;

  const servers = await api.call<{ port: number; url: string }[]>("servers");
  api.check(
    "the dev server and the server behind it are announced",
    servers.length === 2 && servers.some((s) => s.port === DEV_PORT),
    JSON.stringify(servers),
  );
  for (const server of servers) {
    const page = await api.preview(server.url);
    await page.expect(
      `port ${server.port} serves the app`,
      (view) => view.title === TITLE && view.text.includes(WELCOME) && view.overlay === null,
      30000,
    );
  }
  const state = await api.call<{ exited: number | null }>("read", runner.id);
  api.check("the dev server is still running", state.exited === null, `exited ${state.exited}`);
}
