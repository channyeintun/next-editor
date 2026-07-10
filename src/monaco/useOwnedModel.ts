import { useLayoutEffect, useState } from "react";
import { monaco } from "./runtime";

interface UseOwnedModelOptions {
  uri: string;
  value: string;
  language: string;
}

/**
 * Creates a Monaco model owned by the calling component and disposes it on
 * unmount or URI change.
 *
 * Creation lives in a layout effect (not render) and the model is held in
 * state so the ownership cycle survives StrictMode's dev-only effect replay:
 * the replayed cleanup disposes the model, the replayed setup re-creates it,
 * and the state update re-renders with the fresh instance. Returns null until
 * the first effect commits — <MonacoEditor> accepts a null model and attaches
 * it as soon as it arrives, all before paint.
 */
export function useOwnedModel({ uri, value, language }: UseOwnedModelOptions) {
  const [model, setModel] = useState<monaco.editor.ITextModel | null>(null);

  // Keyed by URI only: the model is created with whatever value/language are
  // current at that point, and the sync effect below reconciles later changes.
  useLayoutEffect(() => {
    const parsedUri = monaco.Uri.parse(uri);
    const ownedModel =
      monaco.editor.getModel(parsedUri) ?? monaco.editor.createModel(value, language, parsedUri);
    setModel(ownedModel);

    return () => {
      setModel(null);
      ownedModel.dispose();
    };
  }, [uri]);

  useLayoutEffect(() => {
    if (!model || model.isDisposed()) {
      return;
    }

    if (model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language);
    }

    if (model.getValue() !== value) {
      model.setValue(value);
    }
  }, [language, model, value]);

  return model;
}
