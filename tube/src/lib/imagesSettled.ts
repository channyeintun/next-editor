/**
 * Resolves once every one of `images` has loaded or failed; at once for any
 * that already had. Window `load` is no substitute on this client-rendered
 * page: it fires before the cards render, so before their images are even
 * requested.
 */
export function whenImagesSettle(images: Iterable<HTMLImageElement>): Promise<void> {
  const loading = Array.from(images).filter((image) => !image.complete);
  return Promise.all(
    loading.map(
      (image) =>
        new Promise<void>((resolve) => {
          // `complete` stays false until one of these fires.
          const onSettled = () => {
            image.removeEventListener("load", onSettled);
            image.removeEventListener("error", onSettled);
            resolve();
          };
          image.addEventListener("load", onSettled);
          image.addEventListener("error", onSettled);
        }),
    ),
  ).then(() => {});
}

/** The images inside `container` that are at least partly in the viewport now. */
export function onScreenImages(container: HTMLElement): HTMLImageElement[] {
  return Array.from(container.querySelectorAll("img")).filter((image) => {
    const rect = image.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  });
}
