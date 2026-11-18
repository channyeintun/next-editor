// Every starter template: install, `pnpm dev`, and what the starter shows (a
// preview, or a program's output). Each starter is a section: one that fails
// is reported, the others still run, and the run fails at its end.
// STARTERS=vue,solid narrows the list. INSTALL_ONLY=1 stops after the install.
// TRACE=1 prints the responses without a type or with an error status.
import { fileURLToPath } from "node:url";
import type { HarnessApi } from "../webnode-harness";
import { plainText as strip } from "./text";

export const STARTERS_ROOT = fileURLToPath(new URL("../../src/starters/", import.meta.url));
const ROOT = STARTERS_ROOT;

/** What `pnpm dev` leads to: a page on a port, or a program that prints and exits 0. */
export type Shows = { port: number; title: string; text: string } | { output: string };

const SQUARES = "1 squared is 1\n2 squared is 4\n3 squared is 9\n4 squared is 16\n5 squared is 25";
export const STARTERS: Record<string, { file: string; factory: string; shows: Shows }> = {
  react: {
    file: "react.ts",
    factory: "createStarterWorkspaceProject",
    shows: {
      port: 4173,
      title: "TanStack Start | Type-Safe, Client-First, Full-Stack React",
      text: "Welcome to TanStack Start",
    },
  },
  vue: {
    file: "vue.ts",
    factory: "createStarterVueWorkspace",
    shows: {
      port: 4173,
      title: "Vue Lesson",
      text: "Hello Vue Edit src/App.vue to get started. Count is 0",
    },
  },
  solid: {
    file: "solid.ts",
    factory: "createStarterSolidWorkspace",
    shows: {
      port: 4173,
      title: "Solid Lesson",
      text: "Hello Solid Edit src/App.jsx to get started. Count is 0",
    },
  },
  svelte: {
    file: "svelte.ts",
    factory: "createStarterSvelteWorkspace",
    shows: {
      port: 4173,
      title: "Svelte Lesson",
      text: "Hello Svelte Edit src/App.svelte to get started. Count is 0",
    },
  },
  htmlCss: {
    file: "htmlCss.ts",
    factory: "createStarterHtmlCssWorkspace",
    shows: {
      port: 4173,
      title: "HTML/CSS Lesson",
      text: "Hello world Edit index.html and styles.css to get started.",
    },
  },
  htmx: {
    file: "htmxExpress.ts",
    factory: "createStarterHtmxExpressWorkspace",
    shows: {
      port: 3000,
      title: "HTMX + Express Lesson",
      text: "Hello HTMX This button asks the Express server for the current time.",
    },
  },
  alpine: {
    file: "alpineExpress.ts",
    factory: "createStarterAlpineExpressWorkspace",
    shows: {
      port: 3000,
      title: "Alpine AJAX + Express Lesson",
      text: "Hello Alpine AJAX This form asks the Express server for the current time.",
    },
  },
  expressTs: {
    file: "expressTs.ts",
    factory: "createStarterExpressTsWorkspace",
    shows: {
      port: 3000,
      title: "Express + TypeScript Lesson",
      text: "Express + TypeScript A minimal JSON backend.",
    },
  },
  javascript: {
    file: "javascript.ts",
    factory: "createStarterJavascriptWorkspace",
    shows: { output: `Hello, JavaScript lessons!\n${SQUARES}` },
  },
  typescript: {
    file: "typescript.ts",
    factory: "createStarterTypescriptWorkspace",
    shows: { output: `Hello, TypeScript lessons!\n${SQUARES}` },
  },
  kiteWeb: {
    file: "kiteWeb.ts",
    factory: "createStarterKiteWebWorkspace",
    shows: {
      port: 4173,
      title: "Kite + Vite",
      text: "Every number below is computed by WebAssembly",
    },
  },
};

function tree(files: Record<string, { content?: string }>) {
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
  api.page.on("response", (r) => {
    const type = r.headers()["content-type"] ?? "";
    if (process.env.TRACE && (type === "" || r.status() >= 400) && !r.url().endsWith("favicon.ico"))
      console.log(
        `[response ${r.status()} type="${type}"] ${r.url().replace(/^https?:\/\/[^/]+/, "")}`,
      );
  });
  const names = (process.env.STARTERS ?? Object.keys(STARTERS).join(",")).split(",");
  for (const name of names) {
    const starter = STARTERS[name];
    if (!starter) throw new Error(`no starter named ${name}: ${Object.keys(STARTERS).join(", ")}`);
    const project = (await import(ROOT + starter.file))[starter.factory]();
    const pkg = project.files["package.json"]
      ? JSON.parse(project.files["package.json"].content)
      : {};
    await api.section(
      `${name}: dev="${pkg.scripts?.dev}" deps=${Object.entries({
        ...pkg.dependencies,
        ...pkg.devDependencies,
      })
        .map(([n, v]) => `${n}@${v}`)
        .join(" ")}`,
      async () => {
        await api.call("teardown");
        await api.call("boot");
        await api.call("mount", tree(project.files));
        let t = Date.now();
        const install = await api.sh("pnpm install", { timeoutMs: 400000 });
        const lines = strip(install.output)
          .split("\n")
          .filter((l) => l.trim() && !l.startsWith("Progress"));
        api.check(
          `pnpm install exits 0 (${Date.now() - t} ms)`,
          install.code === 0,
          `exit ${install.code}${install.timedOut ? ", timed out" : ""}: ${lines.slice(-12).join(" | ")}\n   raw tail: ${JSON.stringify(install.output.slice(-1500))}`,
        );
        if (process.env.INSTALL_ONLY) return;
        t = Date.now();
        const shows = starter.shows;
        if ("output" in shows) {
          const dev = await api.sh("pnpm dev", { timeoutMs: 90000 });
          const output = strip(dev.output).trim();
          api.check(
            `pnpm dev prints the program's output and exits 0 (${Date.now() - t} ms)`,
            dev.code === 0 && output.endsWith(shows.output),
            `exit ${dev.code}${dev.timedOut ? ", timed out" : ""}: ${JSON.stringify(output.slice(-800))}`,
          );
          return;
        }
        const runner = await api.terminal("sh", ["-lc", "pnpm dev"]);
        const server = await api.server({ port: shows.port, runner, timeoutMs: 90000 });
        api.check(`server on ${server.port} announced (${Date.now() - t} ms)`, true);
        t = Date.now();
        const preview = await api.preview(server.url);
        const view = await preview.expect(
          `the preview shows ${JSON.stringify(shows.title)}`,
          (shown) =>
            shown.title === shows.title &&
            shown.text.includes(shows.text) &&
            shown.overlay === null,
          60000,
        );
        console.log(`     in ${Date.now() - t} ms: ${JSON.stringify(view.text.slice(0, 120))}`);
        const state = await api.call<{ output: string; exited: number | null }>("read", runner.id);
        api.check(
          "the dev server is still running",
          state.exited === null,
          `exited ${state.exited}: ${JSON.stringify(strip(state.output).slice(-600))}`,
        );
        await api.closePreview();
      },
    );
  }
}
