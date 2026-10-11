import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { MAX_ENCODED_YJS_SNAPSHOT_LENGTH, MAX_YJS_SNAPSHOT_BYTES } from "./protocol";
import {
  createCollaborationRoomSnapshot,
  createCollaborationTeachingInitialization,
} from "./yjsUpdates";

const CLIENT_ID = "00000000-0000-4000-8000-000000000001";

describe("snapshot size limit", () => {
  // The room panel shows the thrown message as is, and a schema failure's
  // message is a JSON dump of its issues.
  it("refuses a room snapshot over the limit with a plain message", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "x".repeat(MAX_YJS_SNAPSHOT_BYTES + 1));

    expect(() => createCollaborationRoomSnapshot(doc, CLIENT_ID)).toThrow(
      new Error("This project is too large to share as a live room (limit 4 MiB)."),
    );
  });

  it("refuses a teaching initialization over the limit with the same message", () => {
    expect(() =>
      createCollaborationTeachingInitialization(
        new Uint8Array(MAX_YJS_SNAPSHOT_BYTES + 1),
        CLIENT_ID,
      ),
    ).toThrow(/^This project is too large to share as a live room/);
  });

  // Above ~4.4M base64 characters (~3.3 MiB) a grouped base64 regex overflows
  // V8's regexp stack, so a snapshot inside the limit threw a RangeError.
  it("shares a snapshot right at the limit", () => {
    const update = new Uint8Array(MAX_YJS_SNAPSHOT_BYTES).fill(0x41);

    expect(createCollaborationTeachingInitialization(update, CLIENT_ID).update).toHaveLength(
      MAX_ENCODED_YJS_SNAPSHOT_LENGTH,
    );
  });

  it("shares a room snapshot of a project just under the limit", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "x".repeat(MAX_YJS_SNAPSHOT_BYTES - 1024));

    expect(() => createCollaborationRoomSnapshot(doc, CLIENT_ID)).not.toThrow();
  });
});
