/**
 * The site a driver command talks to: whether it is this machine, and the
 * URLs the driver opens or asks on it.
 */

import { PUBLISHED_SCRIPT_INDEX_PATH } from "../../src/studio/plans/publishedScripts.ts";

/**
 * Whether a host name always means this machine. Only those may be written to
 * by `login --local`, and only on those may a render use a local script the
 * site does not publish (the dev server serves the working tree).
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function isLoopbackUrl(url: string): boolean {
  return isLoopbackHost(new URL(url).hostname);
}

/**
 * The bare studio page: no `?plan`, no `?autostart`. A URL that carried
 * autostart would start a render of its own on every reload, and collide with
 * the one the driver asks for.
 */
export function studioPageUrl(site: string): string {
  return `${site}/studio`;
}

export function authMeUrl(site: string): string {
  return `${site}/api/auth/me`;
}

export function publishedIndexUrl(site: string): string {
  return `${site}${PUBLISHED_SCRIPT_INDEX_PATH}`;
}
