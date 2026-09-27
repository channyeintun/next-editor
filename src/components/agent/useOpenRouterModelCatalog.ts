import { useEffect, useRef, useState } from "react";
import { FALLBACK_MODEL_OPTIONS, fetchOpenRouterModelOptions } from "../../agent/modelCatalog";

/**
 * The OpenRouter models the agent can use. The list is fetched the first time the
 * settings open, and again on a later open until a fetch returns models; until then,
 * and after a failed or empty fetch, it is the built-in fallback list.
 */
export function useOpenRouterModelCatalog(isSettingsOpen: boolean) {
  const [modelOptions, setModelOptions] = useState(FALLBACK_MODEL_OPTIONS);
  const [isModelCatalogLoading, setIsModelCatalogLoading] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const hasLoadedModelCatalogRef = useRef(false);

  useEffect(() => {
    if (!isSettingsOpen || hasLoadedModelCatalogRef.current) {
      return;
    }

    const controller = new AbortController();
    setIsModelCatalogLoading(true);
    setModelCatalogError(null);

    void fetchOpenRouterModelOptions(controller.signal)
      .then((options) => {
        if (options.length > 0) {
          setModelOptions(options);
          hasLoadedModelCatalogRef.current = true;
        } else {
          setModelCatalogError("OpenRouter returned no models; showing fallbacks.");
        }
      })
      .catch((catalogError: unknown) => {
        if (!controller.signal.aborted) {
          setModelCatalogError(
            catalogError instanceof Error
              ? `${catalogError.message}; showing fallback models.`
              : "Could not load OpenRouter models; showing fallbacks.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsModelCatalogLoading(false);
        }
      });

    return () => controller.abort();
  }, [isSettingsOpen]);

  return { modelOptions, isModelCatalogLoading, modelCatalogError };
}
