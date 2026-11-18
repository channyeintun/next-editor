// One run of Myanmar-script words, with the spaces between them. Myanmar vowel
// signs and other combining marks have Script=Myanmar, so they stay in the run.
// The capturing group makes split() keep each run at an odd index.
const MYANMAR_RUN = /(\p{Script=Myanmar}+(?:\s+\p{Script=Myanmar}+)*)/u;

// Renders text that may mix English with Burmese (Myanmar script), such as the
// lesson title "Rust from zero: Data type တွေ". The page is lang="en", so each
// Burmese run is wrapped in <span lang="my"> and screen readers switch to a
// Burmese voice for it (WCAG 2.2 SC 3.1.2 Language of Parts). English terms
// stay in the page language. Text with no Myanmar script renders unchanged.
//
// Burmese vowel signs and stacked consonants draw up to 1em above the baseline
// and 0.5em below it, past the line box of the tight line heights used for
// titles. Wherever that line is clipped (truncate, line-clamp), their bottoms
// get cut off. A taller line box for the Burmese run holds them: measured in
// Chrome on macOS, Telegraf needs a line height of 1.66 and the system UI font
// needs 1.76. A clip margin cannot do this for line-clamp, because it uncovers
// the hidden next line.
export default function LangText({ text }: { text: string }) {
  const parts = text.split(MYANMAR_RUN);
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <span key={index} lang="my" className="leading-[1.8]">
        {part}
      </span>
    ) : (
      part
    ),
  );
}
