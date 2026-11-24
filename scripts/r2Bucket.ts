/**
 * The name of the R2 bucket the Worker binds as BUCKET, read from a wrangler
 * config. The upload tools (prepared installs, lesson scripts) put objects
 * with `wrangler r2 object put <bucket>/<key>`, and both must name the bucket
 * the Worker reads, so the lookup has one home.
 */

import { readFileSync } from "node:fs";

export function boundBucketName(wranglerConfigPath: string): string {
  const config = readFileSync(wranglerConfigPath, "utf8");
  for (const block of config.split("[[r2_buckets]]").slice(1)) {
    const section = block.split(/^\[/m)[0];
    if (/^\s*binding\s*=\s*"BUCKET"/m.test(section)) {
      const name = /^\s*bucket_name\s*=\s*"([^"]+)"/m.exec(section)?.[1];
      if (name) {
        return name;
      }
    }
  }
  throw new Error(`no r2 bucket bound as BUCKET in ${wranglerConfigPath}`);
}
