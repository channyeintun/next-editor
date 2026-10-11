import type { CaptionNotice } from "../../hooks/useCaptionGeneration";

/**
 * The player's status region for captions that were generated or imported, saying the
 * latest of `notices`. The bar keeps it mounted, outside the Settings menu (usually closed
 * when a job ends), so its words are inserted into a region the screen reader already has.
 */
export default function CaptionStatus({ notices }: { notices: (CaptionNotice | null)[] }) {
  let latest: CaptionNotice | null = null;
  for (const notice of notices) {
    if (notice && (!latest || notice.at > latest.at)) latest = notice;
  }
  return (
    <div role="status" className="sr-only">
      {latest ? <span key={latest.at}>{latest.text}</span> : null}
    </div>
  );
}
