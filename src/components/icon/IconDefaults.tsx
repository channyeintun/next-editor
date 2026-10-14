import type { ReactNode } from "react";
import { LucideProvider } from "lucide-react";

/**
 * The line weight of every Lucide icon, in its 24-unit grid: a fine line, lighter than
 * Lucide's 2, so a 16px icon draws one pixel. An icon that needs another weight passes its
 * own `strokeWidth`.
 */
export const ICON_STROKE_WIDTH = 1.5;

/**
 * The app's icon defaults, round every React root: the client's (src/main.tsx) and the
 * landing page's prerender (infra/worker/ssr/landing.tsx), which must match for hydration.
 */
export default function IconDefaults({ children }: { children: ReactNode }) {
  return <LucideProvider strokeWidth={ICON_STROKE_WIDTH}>{children}</LucideProvider>;
}
