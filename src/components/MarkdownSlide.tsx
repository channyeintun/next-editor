import { marked } from "marked";
import { createSandboxedSlideDocument } from "../utils/sandboxedSlideDocument";

interface MarkdownSlideProps {
  content: string;
  onLoad?: () => void;
}

export default function MarkdownSlide({ content, onLoad }: MarkdownSlideProps) {
  const html = marked(content, { async: false });

  return (
    <iframe
      title="Markdown slide"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={createSandboxedSlideDocument(
        `<main class="slide-markdown" style="box-sizing:border-box;width:100%;height:100%;padding:3rem;color:white">${html}</main>`,
        "text/html",
      )}
      onLoad={onLoad}
      className="size-full border-0 bg-black"
      style={{ colorScheme: "dark" }}
    />
  );
}
