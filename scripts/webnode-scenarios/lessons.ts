// Lessons' own workspaces: the lesson's init command, its run command, the
// server on its port, and a preview that loaded the lesson's page without an
// error overlay. Each lesson is a section: one that fails is reported, the
// others still run, and the run fails at its end.
// LESSONS=slug,slug narrows the list. SETTLE=<ms> is how long the preview is
// watched after it first showed the page (2500).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { HarnessApi } from "../webnode-harness";
import { plainText as strip } from "./text";

/** Where the lessons' scripts are. */
export const LESSON_SCRIPTS = fileURLToPath(new URL("../../src/studio/scripts/", import.meta.url));

const DEFAULT_LESSONS = [
  "next-editor-intro-mm",
  "css-course-01-basics",
  "react-crash-course-03-state-events",
  "typescript-course-07-functions",
  "testing-course-02-first-vitest-test",
  "a11y-course-08-keyboard-focus",
  "ai-course-07-generative-loop",
  "css-course-43-tailwind",
];
/** Lessons whose page has no text when the lesson starts: the lesson writes it. */
export const EMPTY_AT_START = new Set([
  "next-editor-intro-mm",
  "react-crash-course-01-components-jsx",
]);

/** `files` (path to contents) as the tree `mount` takes. */
export function tree(files: Record<string, string>) {
  const root: any = {};
  for (const [path, contents] of Object.entries(files)) {
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= { directory: {} }).directory;
    node[parts.at(-1)!] = { file: { contents } };
  }
  return root;
}

/** The text of the page's <title>, as the browser reports it. */
export function titleOf(html: string): string {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  return title
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function (api: HarnessApi) {
  const slugs = (process.env.LESSONS ?? DEFAULT_LESSONS.join(",")).split(",");
  const consoleErrors: string[] = [];
  api.page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  for (const slug of slugs) {
    const lesson = parse(readFileSync(`${LESSON_SCRIPTS}${slug}.yaml`, "utf8"));
    const files = lesson.lesson.workspace.files as Record<string, string>;
    const pkg = files["package.json"] ? JSON.parse(files["package.json"]) : {};
    await api.section(
      `${slug}  deps: ${Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
        .map(([n, v]) => `${n}@${v}`)
        .join(" ")}  dev: ${pkg.scripts?.dev}`,
      async () => {
        consoleErrors.length = 0;
        await api.call("teardown");
        await api.call("boot");
        await api.call("mount", tree(files));
        let t = Date.now();
        const init = lesson.runtime.initCommand as string;
        if (init) {
          const r = await api.sh(init, { timeoutMs: 240000 });
          const out = strip(r.output)
            .split("\n")
            .filter((l) => !l.startsWith("Progress:") && l.trim());
          api.check(
            `${init} exits 0 (${Date.now() - t} ms)`,
            r.code === 0,
            `exit ${r.code}${r.timedOut ? ", timed out" : ""}:\n${out.slice(-25).join("\n")}`,
          );
        }
        t = Date.now();
        const runner = await api.terminal("sh", ["-lc", lesson.runtime.runCommand]);
        const port = lesson.runtime.expectedPort ?? 5173;
        const server = await api.server({ port, runner, timeoutMs: 90000 });
        api.check(`server on ${server.port} announced (${Date.now() - t} ms)`, true);
        t = Date.now();
        const title = titleOf(files["index.html"] ?? "");
        const loaded = (view: { title: string; text: string; overlay: string | null }) =>
          view.title === title &&
          view.overlay === null &&
          (view.text.length > 0 || EMPTY_AT_START.has(slug));
        const preview = await api.preview(server.url);
        await preview.expect(
          `the preview loads ${JSON.stringify(title)}${EMPTY_AT_START.has(slug) ? " (a page with no text yet)" : ""}`,
          loaded,
          60000,
        );
        const shownAfter = Date.now() - t;
        await new Promise((r) => setTimeout(r, Number(process.env.SETTLE ?? 2500)));
        const view = await preview.read();
        api.check(
          "and still shows it, without an error overlay, after settling",
          view !== null && loaded(view),
          JSON.stringify(view),
        );
        console.log(`     in ${shownAfter} ms: ${JSON.stringify(view?.text.slice(0, 160))}`);
        const state = await api.call<{ output: string; exited: number | null }>("read", runner.id);
        const tail = strip(state.output)
          .split("\n")
          .filter((l) => l.trim());
        api.check(
          "the dev server is still running",
          state.exited === null,
          `exited ${state.exited}: ${tail.slice(-8).join(" | ")}`,
        );
        // Not a step: a lesson may log errors by design (a failing test, a type error it teaches).
        if (consoleErrors.length)
          console.log(
            `     note, console errors: ${[...new Set(consoleErrors)].slice(0, 6).join(" || ")}`,
          );
        await api.closePreview();
      },
    );
  }
}
