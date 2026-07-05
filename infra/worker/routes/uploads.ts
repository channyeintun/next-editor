import { Hono } from "hono";
import type { Env } from "../env";
import { getLessonById } from "../../db/queries";
import { getCurrentUser } from "../auth/session";

// Mounted at /api/uploads in worker/index.ts. No presigned URLs (no R2
// signing keys are configured — see docs/cloudflare-plan.md's open question
// on this); the client PUTs bytes straight through this Worker route, which
// streams them into R2 without buffering the whole file in memory.
export const uploadsRoute = new Hono<{ Bindings: Env }>();

// filename must be exactly what buildRecordingFiles (src/storage/RecordingStorage.ts)
// already computed client-side (e.g. "recording-1.ogg", "<id>.ne") — constrained to a
// safe charset + a known extension allow-list, not an arbitrary path.
uploadsRoute.put(
  "/:id/media/:filename{[\\w-]+\\.(ne|ogg|weba|webm|mp4|mov|m4a|mp3|wav|png|jpg|jpeg|svg)}",
  async (c) => {
    const user = await getCurrentUser(c);
    if (!user) {
      return c.json({ error: "not signed in" }, 401);
    }

    const { id, filename } = c.req.param();

    // A lesson row for this id may not exist yet (this is the very first
    // upload before POST /api/lessons creates the draft) — that's fine, any
    // signed-in user can claim a fresh id they generated themselves. But if a
    // row DOES already exist, only its owner may write more media under it —
    // otherwise a malicious signed-in user could extract another lesson's id
    // from its public `ne`/`thumbnail` path and overwrite that media.
    const existing = await getLessonById(c.env.DB, id);
    if (existing && existing.owner_id !== user.id) {
      return c.json({ error: "forbidden" }, 403);
    }

    if (!c.req.raw.body) {
      return c.json({ error: "empty body" }, 400);
    }

    const key = `lessons/${id}/${filename}`;
    await c.env.BUCKET.put(key, c.req.raw.body, {
      httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" },
    });

    return c.json({ path: key });
  },
);
