import { describe, expect, it } from "vitest";
import { shouldSendPostHogEvent } from "./posthogExceptionFilter";

describe("shouldSendPostHogEvent", () => {
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
