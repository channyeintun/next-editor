import type { AgentModelId } from "./types";

export interface AgentModelOption {
  id: AgentModelId;
  label: string;
  supportsImages: boolean;
}

interface OpenRouterModel {
  id?: unknown;
  name?: unknown;
  architecture?: {
    input_modalities?: unknown;
  };
}

interface OpenRouterModelsResponse {
  data?: unknown;
}

export const FALLBACK_MODEL_OPTIONS: AgentModelOption[] = [
  { id: "anthropic/claude-haiku-4.5", label: "Anthropic: Claude Haiku 4.5", supportsImages: true },
  { id: "anthropic/claude-opus-4.8", label: "Anthropic: Claude Opus 4.8", supportsImages: true },
  { id: "anthropic/claude-sonnet-5", label: "Anthropic: Claude Sonnet 5", supportsImages: true },
  { id: "openai/gpt-5.4", label: "OpenAI: GPT-5.4", supportsImages: true },
  { id: "openai/gpt-5.4-mini", label: "OpenAI: GPT-5.4 Mini", supportsImages: true },
  { id: "openai/gpt-5.5", label: "OpenAI: GPT-5.5", supportsImages: true },
  { id: "openai/gpt-5.6-sol", label: "OpenAI: GPT-5.6 Sol", supportsImages: true },
  { id: "openai/gpt-5.6-sol-pro", label: "OpenAI: GPT-5.6 Sol Pro", supportsImages: true },
  { id: "openai/gpt-5.6-terra", label: "OpenAI: GPT-5.6 Terra", supportsImages: true },
  { id: "openai/gpt-5.6-terra-pro", label: "OpenAI: GPT-5.6 Terra Pro", supportsImages: true },
  { id: "openai/gpt-5.6-luna", label: "OpenAI: GPT-5.6 Luna", supportsImages: true },
  { id: "openai/gpt-5.6-luna-pro", label: "OpenAI: GPT-5.6 Luna Pro", supportsImages: true },
  { id: "google/gemma-4-26b-a4b-it", label: "Google: Gemma 4 26B A4B", supportsImages: true },
  { id: "google/gemini-3.1-pro-preview", label: "Google: Gemini 3.1 Pro Preview", supportsImages: true },
  { id: "google/gemini-3-flash-preview", label: "Google: Gemini 3 Flash Preview", supportsImages: true },
];

function hasModelId(model: OpenRouterModel): model is OpenRouterModel & { id: string } {
  return typeof model.id === "string";
}

export async function fetchOpenRouterModelOptions(
  signal?: AbortSignal,
): Promise<AgentModelOption[]> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error(`OpenRouter model catalog returned ${response.status}`);
  }

  const payload = (await response.json()) as OpenRouterModelsResponse;
  const models = Array.isArray(payload.data) ? (payload.data as OpenRouterModel[]) : [];

  return models
    .filter(hasModelId)
    .map((model) => ({
      id: model.id,
      label: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
      supportsImages:
        Array.isArray(model.architecture?.input_modalities) &&
        model.architecture.input_modalities.includes("image"),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function filterModelOptions(
  options: AgentModelOption[],
  query: string,
): AgentModelOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return options;
  }

  return options.filter(
    (option) =>
      option.label.toLocaleLowerCase().includes(normalizedQuery) ||
      option.id.toLocaleLowerCase().includes(normalizedQuery),
  );
}
