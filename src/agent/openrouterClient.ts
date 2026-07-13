import { OpenRouter } from "@openrouter/agent";

/**
 * The OpenRouter agent SDK talks to the API entirely over `fetch`, so it runs
 * client-side. The key is the user's own OpenRouter key (BYOK), held in memory
 * unless they opt into persistence — see `credentials.ts`.
 */
export function createOpenRouterClient(apiKey: string): OpenRouter {
  return new OpenRouter({ apiKey });
}
