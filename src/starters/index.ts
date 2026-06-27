import type { WorkspaceLessonType, WorkspaceProject } from "../types/workspace";

/**
 * Each starter embeds the full source of its "hello world" project as inline
 * strings, so eagerly importing all of them bloats the main bundle. Mapping
 * every lesson type to a dynamic `import()` lets the bundler split each starter
 * into its own chunk that is only fetched when the user actually switches to
 * that framework from the settings menu.
 *
 * `html-css` and `react` are also imported statically by the workspace store
 * (they are the boot default and the empty-workspace fallback), so the bundler
 * keeps them in the main bundle — only `vue`, `solid`, `svelte`, `htmx-express`,
 * and `express-ts` become lazily loaded chunks.
 */
const STARTER_LOADERS: Record<WorkspaceLessonType, () => Promise<() => WorkspaceProject>> = {
  "html-css": () => import("./htmlCss").then((module) => module.createStarterHtmlCssWorkspace),
  react: () => import("./react").then((module) => module.createStarterWorkspaceProject),
  vue: () => import("./vue").then((module) => module.createStarterVueWorkspace),
  solid: () => import("./solid").then((module) => module.createStarterSolidWorkspace),
  svelte: () => import("./svelte").then((module) => module.createStarterSvelteWorkspace),
  "htmx-express": () =>
    import("./htmxExpress").then((module) => module.createStarterHtmxExpressWorkspace),
  "express-ts": () =>
    import("./expressTs").then((module) => module.createStarterExpressTsWorkspace),
};

/** Lazily load and build a fresh starter workspace for the given lesson type. */
export async function createStarterWorkspaceForLessonType(
  lessonType: WorkspaceLessonType,
): Promise<WorkspaceProject> {
  const createStarter = await STARTER_LOADERS[lessonType]();

  return createStarter();
}
