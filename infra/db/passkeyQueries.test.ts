// @vitest-environment node
import { describe, expect, it, vi } from "vite-plus/test";
import { getPasskeyCredentialWithUser, insertPasskeyCredential } from "./passkeyQueries";
import { insertSignedInUser, openSqliteD1 } from "./testing";

describe("getPasskeyCredentialWithUser", () => {
  // Passkey sign-in has no session yet, so this lookup sits in front of the
  // login response: one round trip for the credential and its owner.
  it("answers the credential and its owner in one batch", async () => {
    const { db, sqlite } = openSqliteD1();
    insertSignedInUser(sqlite, "user-1", "session-1");
    insertSignedInUser(sqlite, "user-2", "session-2");
    for (const [id, userId] of [
      ["credential-1", "user-1"],
      ["credential-2", "user-2"],
    ]) {
      await insertPasskeyCredential(db, {
        id,
        userId,
        publicKey: `key-${id}`,
        counter: 3,
        transports: ["internal"],
      });
    }
    const batch = vi.spyOn(db, "batch");

    const match = await getPasskeyCredentialWithUser(db, "credential-2");

    expect(match?.credential).toMatchObject({
      id: "credential-2",
      user_id: "user-2",
      public_key: "key-credential-2",
      counter: 3,
      transports: '["internal"]',
    });
    expect(match?.user).toMatchObject({ id: "user-2", username: "user-2" });
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("answers null for an unknown credential", async () => {
    const { db, sqlite } = openSqliteD1();
    insertSignedInUser(sqlite, "user-1", "session-1");

    await expect(getPasskeyCredentialWithUser(db, "unknown")).resolves.toBeNull();
  });
});
