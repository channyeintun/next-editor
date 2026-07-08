import { useEffect, useMemo, useRef } from "react";
import { monaco } from "./runtime";

interface UseOwnedModelOptions {
  uri: string;
  value: string;
  language: string;
}

export function useOwnedModel({ uri, value, language }: UseOwnedModelOptions) {
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const parsedUri = useMemo(() => monaco.Uri.parse(uri), [uri]);

  if (!modelRef.current || modelRef.current.uri.toString() !== uri) {
    modelRef.current?.dispose();
    modelRef.current = monaco.editor.createModel(value, language, parsedUri);
  }

  useEffect(() => {
    const model = modelRef.current;

    if (!model) {
      return;
    }

    if (model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language);
    }

    if (model.getValue() !== value) {
      model.setValue(value);
    }
  }, [language, value]);

  useEffect(() => {
    const model = modelRef.current;

    return () => {
      if (modelRef.current === model) {
        modelRef.current = null;
      }
      model?.dispose();
    };
  }, [uri]);

  return modelRef.current;
}
