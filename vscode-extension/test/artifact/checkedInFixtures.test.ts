import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { openArtifact } from "../../src/storage/ArtifactReader";

// The committed §21.4 reproduction fixtures must keep opening with the
// current reader; regenerate with scripts/generate-fixture.mjs on format
// changes (format changes require a version bump per plan §7).
const fixturesRoot = path.resolve(__dirname, "..", "..", "fixtures", "recordings");

describe("checked-in reproduction fixtures", () => {
  it("minimal fixture round-trips", async () => {
    const reader = await openArtifact(path.join(fixturesRoot, "minimal", "minimal.nextrecording"));
    try {
      expect(reader.manifest.documents).toHaveLength(1);
      const events = await reader.readEvents();
      expect(events[events.length - 1]?.type).toBe("session.finalized");
    } finally {
      await reader.close();
    }
  });

  it("multi-document fixture has three documents and two groups", async () => {
    const reader = await openArtifact(
      path.join(fixturesRoot, "multi-document", "multi-document.nextrecording"),
    );
    try {
      expect(reader.manifest.documents).toHaveLength(3);
      const events = await reader.readEvents();
      const topology = events.find((event) => event.type === "topology.snapshot");
      const groupCount =
        topology?.type === "topology.snapshot" ? topology.payload.groups.length : -1;
      expect(groupCount).toBe(2);
    } finally {
      await reader.close();
    }
  });

  it("same-document fixture shows one document in two groups", async () => {
    const reader = await openArtifact(
      path.join(
        fixturesRoot,
        "same-document-two-surfaces",
        "same-document-two-surfaces.nextrecording",
      ),
    );
    try {
      expect(reader.manifest.documents).toHaveLength(1);
      const events = await reader.readEvents();
      const opened = events.filter((event) => event.type === "surface.opened");
      expect(opened).toHaveLength(2);
    } finally {
      await reader.close();
    }
  });

  it("corrupt fixture fails closed", async () => {
    await expect(
      openArtifact(path.join(fixturesRoot, "corrupt", "truncated.nextrecording")),
    ).rejects.toThrow(/archive|zip|entry|central/i);
  });
});
