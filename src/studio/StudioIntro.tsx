import { LESSON_SCRIPT_DOCS_URL } from "./lessonScriptDocs";

/**
 * What Studio is, in two sentences at the top of the console. Visitors arrive
 * from the landing page and the account menu, and nothing else on this page
 * says what the console does.
 */
export default function StudioIntro() {
  return (
    <p className="mt-2 text-[12px] text-slate-400">
      Pick a lesson script or import your own. Studio narrates it, performs it in this editor, and
      records it.{" "}
      <a
        href={LESSON_SCRIPT_DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="whitespace-nowrap text-slate-200 underline underline-offset-2 transition-colors hover:text-white"
      >
        How to write a script
      </a>
    </p>
  );
}
