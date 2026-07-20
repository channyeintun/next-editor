import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Atomic durable writes (plan §9.2): complete temp file in the same
// directory, flush, rename over the previous file.
export async function atomicWriteFile(file: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  try {
    const handle = await fs.open(temp, "wx");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteFile(file, JSON.stringify(value, null, 2));
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
