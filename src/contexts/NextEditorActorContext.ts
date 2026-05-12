import { createActorContext } from "@xstate/react";
import { editorMachine } from "../core/src/machine/editorMachine";

export const NextEditorActorContext = createActorContext(editorMachine);
