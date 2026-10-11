// While a search the reader asked for is loading, what is on screen stays and
// dims rather than being swapped for a placeholder, so nothing blinks. Dimmed
// content is also inert: it is about to be replaced, so focus must not land in it.
export function busyFadeClass(busy: boolean): string {
  return `transition-opacity duration-200 motion-reduce:transition-none ${busy ? "opacity-50" : "opacity-100"}`;
}

// A new answer comes in whole, from the level the content it replaces was
// dimmed to, so the page never drops below 50% between them. Only the
// wrapper fades: a child fading too would multiply down to 25%.
export const RESULTS_ENTER_CLASS = "starting:opacity-50";
