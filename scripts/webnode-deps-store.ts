// Where this machine keeps the prepared install objects and plans that
// scripts/webnode-deps.ts builds and scripts/webnode-harness.ts serves.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The local store: objects/, plans/ and the upload ledgers. */
export const DEPS_STORE_DIR = resolve(ROOT, "node_modules/.cache/webnode-deps");

/** Every object, Brotli-compressed, as <id>.br. */
export const DEPS_STORE_OBJECTS_DIR = join(DEPS_STORE_DIR, "objects");

/** One record per manifest built, as <manifestHash>.json. */
export const DEPS_STORE_PLANS_DIR = join(DEPS_STORE_DIR, "plans");

/** The ending of an object's file name after its id. */
export const DEPS_STORE_OBJECT_SUFFIX = ".br";

/** The file that keeps object `id`. */
export function depsStoreObjectFile(id: string): string {
  return join(DEPS_STORE_OBJECTS_DIR, `${id}${DEPS_STORE_OBJECT_SUFFIX}`);
}
