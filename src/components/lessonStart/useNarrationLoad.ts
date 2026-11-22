import { useSyncExternalStore } from "react";
import type { ActorRefFrom } from "xstate";
import { NextEditorActorContext } from "../../contexts/NextEditorActorContext";
import type { audioPlaybackActor, NarrationLoadFacts } from "../../core/src/machine/audioActor";

/** A lesson's narration player: the actor that plays it and says how its loading goes. */
export type NarrationPlayer = ActorRefFrom<typeof audioPlaybackActor>;

/**
 * The loaded lesson's narration player, while it has one. Another lesson gets another
 * player, so what was said about the last one is not carried over.
 */
export const useNarrationPlayer = (): NarrationPlayer | undefined =>
  NextEditorActorContext.useSelector((state) => state.children.audioPlayer);

/** The latest word of each narration player. */
const latestFacts = new WeakMap<NarrationPlayer, NarrationLoadFacts>();

/**
 * How the loading of the lesson's narration is going, as its player reports it; null
 * until it has said anything. Read through `useSyncExternalStore`, like the machine's
 * own state: the player says how a wait ended just before the machine ends the hold,
 * and a component that reads both must see them change in the same render.
 */
export function useNarrationLoad(player: NarrationPlayer | undefined): NarrationLoadFacts | null {
  const subscribe = (onChange: () => void) => {
    if (!player) return () => {};
    const subscription = player.on("NARRATION_LOAD", (facts) => {
      latestFacts.set(player, facts);
      onChange();
    });
    return () => subscription.unsubscribe();
  };

  return useSyncExternalStore(subscribe, () => (player ? latestFacts.get(player) : null) ?? null);
}
