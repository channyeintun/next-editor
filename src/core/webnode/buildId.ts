// The id of the build a script belongs to. Every script of one build carries
// the same id (build/webnodeBundle.ts defines it), so a script asks for the
// others of its own build, and a host that serves a newer build refuses the
// request instead of mixing two builds across a deploy (preview/hostResponses.ts).

declare const __WEBNODE_BUILD_ID__: string | undefined;

/** This build's id, or "" where the build gives none (unit tests, the harness page). */
export const BUILD_ID: string =
  typeof __WEBNODE_BUILD_ID__ === "string" ? __WEBNODE_BUILD_ID__ : "";

/** The query parameter a script's URL names its build with. */
export const BUILD_PARAMETER = "v";

/** What an editor of another build is told: its scripts are gone, and a reload brings the new ones. */
export const STALE_BUILD_MESSAGE = "the editor was updated; reload the page to run code again";

/** `path` as a script of build `buildId` asks for it; `path` itself when there is no id. */
export function versionedPath(path: string, buildId: string = BUILD_ID): string {
  return buildId ? `${path}?${BUILD_PARAMETER}=${encodeURIComponent(buildId)}` : path;
}
