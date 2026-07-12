import Anthropic from "@anthropic-ai/sdk";

/**
 * The SDK already sends `anthropic-dangerous-direct-browser-access: true` when
 * `dangerouslyAllowBrowser` is set; it's passed again explicitly here per the
 * documented direct-browser-access contract, in case that default ever changes.
 */
export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders: { "anthropic-dangerous-direct-browser-access": "true" },
  });
}
