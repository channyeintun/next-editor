import type { AgentModelId } from "./types";

export interface AgentModelOption {
  id: AgentModelId;
  label: string;
}

interface OpenRouterModel {
  id?: unknown;
  name?: unknown;
  architecture?: {
    output_modalities?: unknown;
  };
  supported_parameters?: unknown;
}

interface OpenRouterModelsResponse {
  data?: unknown;
}

export const FALLBACK_MODEL_OPTIONS: AgentModelOption[] = [
  { id: "anthropic/claude-haiku-4.5", label: "Anthropic: Claude Haiku 4.5" },
  { id: "anthropic/claude-opus-4.8", label: "Anthropic: Claude Opus 4.8" },
  { id: "anthropic/claude-sonnet-5", label: "Anthropic: Claude Sonnet 5" },
  { id: "openai/gpt-5.4", label: "OpenAI: GPT-5.4" },
  { id: "openai/gpt-5.4-mini", label: "OpenAI: GPT-5.4 Mini" },
  { id: "openai/gpt-5.5", label: "OpenAI: GPT-5.5" },
  { id: "openai/gpt-5.6-sol", label: "OpenAI: GPT-5.6 Sol" },
  { id: "openai/gpt-5.6-sol-pro", label: "OpenAI: GPT-5.6 Sol Pro" },
  { id: "openai/gpt-5.6-terra", label: "OpenAI: GPT-5.6 Terra" },
  { id: "openai/gpt-5.6-terra-pro", label: "OpenAI: GPT-5.6 Terra Pro" },
  { id: "openai/gpt-5.6-luna", label: "OpenAI: GPT-5.6 Luna" },
  { id: "openai/gpt-5.6-luna-pro", label: "OpenAI: GPT-5.6 Luna Pro" },
  { id: "google/gemma-4-26b-a4b-it", label: "Google: Gemma 4 26B A4B" },
  { id: "google/gemma-4-31b-it", label: "Google: Gemma 4 31B" },
  { id: "google/gemini-3.1-pro-preview", label: "Google: Gemini 3.1 Pro Preview" },
  { id: "google/gemini-3-flash-preview", label: "Google: Gemini 3 Flash Preview" },
];

function isToolCapableTextModel(model: OpenRouterModel): model is OpenRouterModel & { id: string } {
  const parameters = Array.isArray(model.supported_parameters)
    ? model.supported_parameters
    : [];
  const outputModalities = Array.isArray(model.architecture?.output_modalities)
    ? model.architecture.output_modalities
    : [];

  return (
    typeof model.id === "string" &&
    !model.id.endsWith(":free") &&
    parameters.includes("tools") &&
    outputModalities.includes("text")
  );
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
    .filter(isToolCapableTextModel)
    .map((model) => ({
      id: model.id,
      label: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
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
