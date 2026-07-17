import { describe, expect, it } from "vitest";
import { signToken, verifyToken } from "./auth";

describe("runtime tokens", () => {
  it("round-trips signed claims", async () => {
    const token = await signToken("a sufficiently long test secret", {
      userId: "user-1",
      exp: Date.now() / 1000 + 60,
      sessionId: "sid",
    });
    await expect(verifyToken("a sufficiently long test secret", token)).resolves.toMatchObject({
      userId: "user-1",
      sessionId: "sid",
    });
  });

  it("rejects tampering and expiration", async () => {
    const token = await signToken("secret", { userId: "user-1", exp: Date.now() / 1000 + 60 });
    await expect(verifyToken("other", token)).rejects.toThrow("invalid token");
    const expired = await signToken("secret", { userId: "user-1", exp: Date.now() / 1000 - 1 });
    await expect(verifyToken("secret", expired)).rejects.toThrow("expired token");
  });
});
