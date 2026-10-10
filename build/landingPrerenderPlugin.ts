import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerImport, type Plugin } from "vite";
import { LANDING_DOCUMENT_FILE } from "../infra/worker/ssr/staticDocuments";

type LandingModule = typeof import("../infra/worker/ssr/landing");

const LANDING_MODULE = fileURLToPath(new URL("../infra/worker/ssr/landing.tsx", import.meta.url));
const APP_SHELL_FILE = "index.html";

/**
 * Renders the landing document (infra/worker/ssr/landing.tsx) from the built
 * index.html and writes it beside it as LANDING_DOCUMENT_FILE, which the
 * Worker serves at `/` as a plain static asset. The markup does not depend on
 * the request, so rendering it once here replaces a React render on every
 * cold isolate, and keeps react-dom/server out of the Worker bundle.
 *
 * The module is loaded through Vite's module runner (with no config of its
 * own, so none of the app's build plugins), which compiles the TSX and leaves
 * every package to Node. A build that cannot produce the document fails
 * rather than ship a landing page without its markup.
 */
export function landingPrerenderPlugin(): Plugin {
  return {
    name: "next-editor-landing-prerender",
    apply: "build",
    async writeBundle({ dir }, bundle) {
      const shell = bundle[APP_SHELL_FILE];
      // Worker and other sub-builds emit no app shell.
      if (!dir || shell?.type !== "asset") return;

      const { module } = await runnerImport<LandingModule>(LANDING_MODULE, { logLevel: "error" });
      const document = module.buildLandingDocument(String(shell.source));
      if (!document.includes('data-ssr="landing"')) {
        throw new Error(`${APP_SHELL_FILE} has no empty #root to prerender the landing page into.`);
      }
      await writeFile(join(dir, LANDING_DOCUMENT_FILE), document);
    },
  };
}
