import { useSyncExternalStore } from "react";
import { NextEditorActorContext } from "../../contexts/NextEditorActorContext";
import type { NarrationLoadFacts } from "../../core/src/machine/audioActor";

/**
 * The latest word of each narration player. Keyed by the player, so a lesson that
 * replaces its player (another recording loaded) starts with nothing said.
 */
const latestFacts = new WeakMap<object, NarrationLoadFacts>();

/**
 * How the lesson's wait for its narration is going, as its player reports it; null
 * until it has said anything. Read through `useSyncExternalStore`, like the machine's
 * own state: the player says how a wait ended just before the machine ends the hold,
 * and a component that reads both must see them change in the same render.
 */
export function useNarrationLoad(): NarrationLoadFacts | null {
  const player = NextEditorActorContext.useSelector((state) => state.children.audioPlayer);

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
