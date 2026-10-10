import posthog from "@posthog/rollup-plugin";
import type { PostHogRollupPluginOptions } from "@posthog/rollup-plugin";
import { resolveConfig, resolveReleaseId } from "@posthog/plugin-utils";
import type { HtmlTagDescriptor, PluginOption } from "vite";

/**
 * The release every JS chunk carries. In its default `event` release mode the
 * PostHog plugin writes `_posthogReleaseId = _posthogReleaseId || "<id>"` into
 * each chunk and folds that line into the chunk's filename hash. With the
 * per-commit release it resolves from git, every deploy renamed 351 of 361
 * chunks, Monaco's 1 MB `editor-*` included, so a returning visitor's first
 * visit after a deploy downloaded the whole bundle again. With a constant
 * here, a chunk's name changes only when its own code (or an import name)
 * does. The chunk ids PostHog symbolicates by stay content-derived either way,
 * and event mode keeps the uploaded source maps release-independent.
 */
export const CHUNK_RELEASE = { releaseName: "next-editor", releaseVersion: "chunks" } as const;

/** `<` would let a release id close the inline script; JSON allows `<`. */
function inlineScriptJson(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/**
 * The real per-deploy release, which the chunks no longer carry. index.html is
 * revalidated on every visit (and is the shell the landing and lesson SSR
 * rewrite), so it sets the global first; each chunk's `||` then keeps it, and
 * posthog-js reads it as `$release_id` when it captures an exception. The
 * release is resolved the way the plugin resolved it before: from `options`
 * (git or CI metadata when they name none).
 */
function deployReleaseHtmlPlugin(options: PostHogRollupPluginOptions): PluginOption {
  return {
    name: "next-editor-posthog-deploy-release",
    apply: "build",
    async transformIndexHtml(): Promise<HtmlTagDescriptor[] | undefined> {
      const config = resolveConfig(options);
      if (!config.sourcemaps.enabled) return undefined;
      const releaseId = await resolveReleaseId(config);
      if (!releaseId) return undefined;
      return [
        {
          tag: "script",
          children: `globalThis._posthogReleaseId=${inlineScriptJson(releaseId)};`,
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

/**
 * PostHog's source-map upload with a constant chunk release, plus the
 * index.html script that reports each deploy's own release.
 */
export function posthogReleasePlugins(options: PostHogRollupPluginOptions): PluginOption[] {
  return [
    posthog({ ...options, sourcemaps: { ...options.sourcemaps, ...CHUNK_RELEASE } }),
    deployReleaseHtmlPlugin(options),
  ];
}
