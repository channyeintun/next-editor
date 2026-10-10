import { useState } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * A card's cover image, or a placeholder icon when there is none or it fails
 * to load. The failure belongs to the source that failed, not to the card: a
 * card that receives a new thumbnail (after "Update thumbnail", or a playlist
 * whose first lesson changed) tries the new image instead of keeping the
 * placeholder until a reload.
 */
export default function ThumbnailTile({
  src,
  alt,
  fallbackIcon: FallbackIcon,
  priority = false,
  hoverScale = false,
}: {
  src: string | null;
  /** The lesson title, or "" for a decorative playlist cover. */
  alt: string;
  fallbackIcon: LucideIcon;
  /** In the first row on screen: the page's LCP candidate, so it loads at once
   *  and at high priority instead of lazily. */
  priority?: boolean;
  /** Zoom the image slightly while the card (a `group`) is hovered. */
  hoverScale?: boolean;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (src === null || failedSrc === src) {
    return (
      <div className="flex size-full items-center justify-center bg-slate-800 text-slate-600">
        <FallbackIcon className="size-8" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      onError={() => setFailedSrc(src)}
      className={`size-full object-cover${
        hoverScale ? " transition-transform duration-300 group-hover:scale-105" : ""
      }`}
    />
  );
}
