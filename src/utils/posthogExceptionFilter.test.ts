import { describe, expect, it } from "vitest";
import { record } from "rrweb";
import {
  POSTHOG_SENSITIVE_SURFACE_SELECTOR,
  sanitizePostHogEvent,
  shouldSendPostHogEvent,
} from "./posthogExceptionFilter";

describe("shouldSendPostHogEvent", () => {
  it("blocks sentinel source, tool, and terminal text from the rrweb payload", async () => {
    expect(POSTHOG_SENSITIVE_SURFACE_SELECTOR).toContain(".ph-no-capture");

    document.body.innerHTML = `
      <main class="ph-no-capture">
        <pre data-sentinel="source">SENTINEL_SOURCE_SECRET</pre>
        <pre data-sentinel="tool">SENTINEL_TOOL_SECRET</pre>
        <pre data-sentinel="terminal">SENTINEL_TERMINAL_SECRET</pre>
      </main>`;

    for (const element of document.querySelectorAll("[data-sentinel]")) {
      expect(element.closest(POSTHOG_SENSITIVE_SURFACE_SELECTOR)).not.toBeNull();
    }

    const events: unknown[] = [];
    const stop = record({
      emit: (event) => events.push(event),
      blockSelector: POSTHOG_SENSITIVE_SURFACE_SELECTOR,
      maskAllInputs: true,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const payload = JSON.stringify(events);
      expect(payload).not.toContain("SENTINEL_SOURCE_SECRET");
      expect(payload).not.toContain("SENTINEL_TOOL_SECRET");
      expect(payload).not.toContain("SENTINEL_TERMINAL_SECRET");
    } finally {
      stop?.();
      document.body.innerHTML = "";
    }
  });

  it("allows an empty event through the PostHog pipeline", () => {
    expect(shouldSendPostHogEvent(null)).toBe(true);
  });

  it("drops exceptions raised by a WebContainer preview", () => {
    expect(
      shouldSendPostHogEvent({
        event: "$exception",
        properties: {
          $exception_list: [
            {
              value: "The user's app crashed",
              stacktrace: {
                frames: [
                  {
                    filename:
                      "https://5173-project.local-credentialless.webcontainer-api.io/src/App.tsx",
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it("drops exceptions from blob scripts created by a WebContainer preview", () => {
    expect(
      shouldSendPostHogEvent({
        event: "$exception",
        properties: {
          $exception_list: [
            {
              stack: "at run (blob:https://project.webcontainer.io/asset-id:1:1)",
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it("keeps application exceptions", () => {
    expect(
      shouldSendPostHogEvent({
        event: "$exception",
        properties: {
          $exception_list: [
            {
              stacktrace: {
                frames: [{ filename: "https://next-editor.example.com/assets/app.js" }],
              },
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("redacts application exception messages, source context, and breadcrumbs", () => {
    const secret = "SENTINEL_API_TOKEN_DO_NOT_CAPTURE";
    const sanitized = sanitizePostHogEvent({
      event: "$exception",
      properties: {
        $current_url: `https://next-editor.example.com/code?token=${secret}`,
        $exception_list: [
          {
            type: "TypeError",
            value: `agent failed with ${secret}`,
            stacktrace: {
              frames: [
                {
                  filename: "https://next-editor.example.com/assets/app.js?private=1",
                  lineno: 10,
                  colno: 2,
                  context_line: `run(${secret})`,
                  pre_context: [secret],
                },
              ],
            },
          },
        ],
        $exception_breadcrumbs: [{ message: secret }],
        request_body: secret,
        response_data: secret,
        command: `echo ${secret}`,
        authorization: `Bearer ${secret}`,
        $referrer: `https://referrer.example/path?secret=${secret}`,
      },
      $set: { private_profile_value: secret },
      $set_once: { private_first_value: secret },
    });

    expect(sanitized).not.toBeNull();
    expect(JSON.stringify(sanitized)).not.toContain(secret);
    expect(sanitized?.properties?.$current_url).toBe("https://next-editor.example.com/code");
    expect(sanitized?.properties?.$referrer).toBe("https://referrer.example/path");
    expect(sanitized?.$set).toBeUndefined();
    expect(sanitized?.$set_once).toBeUndefined();
    expect(sanitized?.properties?.$exception_list).toEqual([
      {
        type: "TypeError",
        value: "[redacted]",
        stacktrace: {
          frames: [
            {
              filename: "https://next-editor.example.com/assets/app.js",
              lineno: 10,
              colno: 2,
            },
          ],
        },
      },
    ]);
  });

  it("drops preview exceptions before attempting redaction", () => {
    expect(
      sanitizePostHogEvent({
        event: "$exception",
        properties: {
          $exception_list: [
            { value: "secret", stack: "https://project.webcontainer-api.io/src/App.tsx" },
          ],
        },
      }),
    ).toBeNull();
  });

  it("does not filter non-exception analytics events", () => {
    expect(
      shouldSendPostHogEvent({
        event: "preview_opened",
        properties: {
          preview_url: "https://project.webcontainer-api.io/",
        },
      }),
    ).toBe(true);
  });
});
