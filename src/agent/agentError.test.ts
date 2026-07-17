import { describe, expect, it } from "vitest";
import { AgentProviderError, formatAgentError } from "./agentError";

describe("formatAgentError", () => {
  it("shows the nested provider explanation embedded in metadata.raw", () => {
    const error = new AgentProviderError(new Error("Provider returned error"), {
      code: 502,
      message: "Provider returned error",
      metadata: {
        provider_name: "Example AI",
        raw: JSON.stringify({
          error: { message: "The selected model is temporarily overloaded." },
        }),
      },
    });

    expect(formatAgentError(error)).toBe(
      [
        "Provider returned error",
        "The selected model is temporarily overloaded.",
        "Code: 502",
        "Provider: Example AI",
      ].join("\n"),
    );
  });

  it("does not serialize unrelated request fields", () => {
    const error = Object.assign(new Error("Request failed"), {
      request: { headers: { authorization: "Bearer secret" } },
      body: JSON.stringify({ error: { message: "Invalid model" } }),
    });

    const formatted = formatAgentError(error);
    expect(formatted).toContain("Invalid model");
    expect(formatted).not.toContain("secret");
  });
});
