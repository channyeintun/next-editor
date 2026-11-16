import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { webnodeHostAsset, webnodeHostResponse } from "../src/core/webnode/preview/hostResponses";
import { isWebnodeHostname } from "../src/core/webnode/preview/origin";
import { buildWebnodeBundles, WEBNODE_BUNDLE_FILES } from "./webnodeBundle";

/** The directory of the build output the Worker reads the runtime's scripts from. */
export const WEBNODE_ASSET_DIRECTORY = "webnode";

const CACHE_DIRECTORY = fileURLToPath(new URL("../node_modules/.cache/webnode", import.meta.url));

/**
 * Builds the webnode runtime's scripts (build/webnodeBundle.ts) and, in dev,
 * serves the runtime's hosts.
 *
 * The runtime never runs on the app's origin. Its kernel and processes run on
 * `runtime.<host>` and each preview on `<session>-<port>.<host>`; those hosts
 * serve the scripts built here and nothing of the app. A dev server answers for
 * `*.localhost` itself, building the scripts on first use; a build emits them
 * under `webnode/` for the Worker to serve on the deployment's wildcard host
 * (infra/worker/webnodePreviewHost.ts).
 */
export function webnodeBundlePlugin(): Plugin {
  let isBuild = false;
  let isClientBuild = false;
  let devBuild: Promise<void> | null = null;

  const read = (file: string) => readFileSync(`${CACHE_DIRECTORY}/${file}`, "utf8");
  const ensureDevBuild = () => {
    devBuild ??= (async () => {
      mkdirSync(CACHE_DIRECTORY, { recursive: true });
      await buildWebnodeBundles({ outDir: CACHE_DIRECTORY });
    })();
    return devBuild;
  };

  return {
    name: "next-editor-webnode-bundles",
    config(config, environment) {
      isBuild = environment.command === "build";
      isClientBuild = isBuild && !config.build?.ssr;
    },
    async buildStart() {
      if (!isClientBuild || process.env.VITEST) {
        return;
      }
      mkdirSync(CACHE_DIRECTORY, { recursive: true });
      await buildWebnodeBundles({ outDir: CACHE_DIRECTORY, minify: true });
      // Fixed names: the runtime's hosts serve these at fixed paths, and a
      // service worker's URL must not change between builds.
      for (const file of Object.values(WEBNODE_BUNDLE_FILES)) {
        this.emitFile({
          type: "asset",
          fileName: `${WEBNODE_ASSET_DIRECTORY}/${file}`,
          source: read(file),
        });
      }
    },
    configureServer(server) {
      // An edit to the engine is picked up by the next runtime boot.
      server.watcher.on("change", (file) => {
        if (file.replaceAll("\\", "/").includes("/src/core/webnode/")) {
          devBuild = null;
        }
      });

      server.middlewares.use((request, response, next) => {
        const [hostname, port] = (request.headers.host ?? "").split(":");
        if (!isWebnodeHostname(hostname, "localhost")) {
          next();
          return;
        }

        const pathname = new URL(request.url ?? "/", "http://internal").pathname;
        ensureDevBuild()
          .then(() => {
            const asset = webnodeHostAsset(pathname);
            const protocol = server.config.server.https ? "https" : "http";
            const answer = webnodeHostResponse(pathname, {
              editorOrigin: `${protocol}://localhost${port ? `:${port}` : ""}`,
              assetSource: asset ? read(asset) : null,
            });
            response.writeHead(answer.status, answer.headers);
            response.end(answer.body);
          })
          .catch((error: unknown) => {
            devBuild = null;
            response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            response.end(`webnode scripts failed to build: ${String(error)}`);
          });
      });
    },
  };
}
