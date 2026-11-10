import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// The real posthog-js pipeline (no mock), with every transport stubbed so nothing
// leaves the process. eventCaptured fires after before_send, with what would be sent.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "sendBeacon");
  Reflect.deleteProperty(document, "visibilityState");
});

const SENTINEL = "SENTINEL_INVITE_TOKEN_DO_NOT_CAPTURE";

describe("PostHog URL privacy", () => {
  it("sends no event carrying a query or fragment from the page URL", async () => {
    vi.stubEnv("VITE_PUBLIC_POSTHOG_PROJECT_TOKEN", "phc_dummy");
    vi.stubEnv("VITE_PUBLIC_POSTHOG_HOST", "http://127.0.0.1:9");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );
    Object.defineProperty(navigator, "sendBeacon", { value: () => true, configurable: true });
    vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    // A room invitation link, opened by the invitee: the token is a bearer credential.
    window.history.replaceState({}, "", `/code?invite=${SENTINEL}#${SENTINEL}`);

    const { initPostHog } = await import("./posthogClient");
    const sent: { event: string; properties: Record<string, unknown> }[] = [];
    const posthog = initPostHog();
    posthog.on("eventCaptured", (event) => sent.push(event as (typeof sent)[number]));
    await vi.waitFor(() => expect(sent.map((event) => event.event)).toContain("$pageview"), {
      timeout: 3_000,
    });

    // Joining removes ?invite=; the session's entry URL and the first-visit person
    // properties still hold the page the session began on.
    window.history.replaceState({}, "", "/code?room=r1");
    posthog.capture("dummy_action");
    posthog.identify("dummy-user");

    expect(sent.map((event) => event.event)).toEqual(
      expect.arrayContaining(["$pageview", "dummy_action", "$identify"]),
    );
    expect(JSON.stringify(sent)).not.toContain(SENTINEL);
    const pageview = sent.find((event) => event.event === "$pageview");
    expect(pageview?.properties).toMatchObject({
      $current_url: `${window.location.origin}/code`,
      $pathname: "/code",
    });
  });
});
