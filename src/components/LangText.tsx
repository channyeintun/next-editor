// One run of Myanmar-script words, with the spaces between them. Myanmar vowel
// signs and other combining marks have Script=Myanmar, so they stay in the run.
// The capturing group makes split() keep each run at an odd index.
const MYANMAR_RUN = /(\p{Script=Myanmar}+(?:\s+\p{Script=Myanmar}+)*)/u;

// Renders text that may mix English with Burmese (Myanmar script), such as the
// lesson title "Rust from zero: Data type တွေ". The page is lang="en", so each
// Burmese run is wrapped in <span lang="my"> and screen readers switch to a
// Burmese voice for it (WCAG 2.2 SC 3.1.2 Language of Parts). English terms
// stay in the page language. Text with no Myanmar script renders unchanged.
export default function LangText({ text }: { text: string }) {
  const parts = text.split(MYANMAR_RUN);
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <span key={index} lang="my">
        {part}
      </span>
    ) : (
      part
    ),
  );
}
