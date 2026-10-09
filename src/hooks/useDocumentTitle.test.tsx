import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StrictMode, type ReactNode } from "react";
import { render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { SITE_TITLE, useDocumentTitle } from "./useDocumentTitle";

function Titled({ title, children }: { title: string | null; children?: ReactNode }) {
  useDocumentTitle(title);
  return <>{children}</>;
}

describe("useDocumentTitle", () => {
  beforeEach(() => {
    document.title = "A stale lesson | Next Editor";
  });

  it("sets the title and follows it as it changes", () => {
    const { rerender } = renderHook(({ title }) => useDocumentTitle(title), {
      initialProps: { title: "Lesson | Next Editor" },
    });
    expect(document.title).toBe("Lesson | Next Editor");

    rerender({ title: "Closures in Rust | Next Editor" });
    expect(document.title).toBe("Closures in Rust | Next Editor");
  });

  it("resets to the site title on unmount, not to the title it replaced", () => {
    const { unmount } = renderHook(() => useDocumentTitle("Lessons | Next Editor"));
    unmount();
    expect(document.title).toBe(SITE_TITLE);
  });

  it("keeps the title through StrictMode's effect replay", () => {
    render(
      <StrictMode>
        <Titled title="Studio | Next Editor" />
      </StrictMode>,
    );
    expect(document.title).toBe("Studio | Next Editor");
  });

  it("lets the next route's title win when one route replaces another", () => {
    const { rerender } = render(<Titled key="gallery" title="Lessons | Next Editor" />);
    rerender(<Titled key="lesson" title="Closures in Rust | Next Editor" />);
    expect(document.title).toBe("Closures in Rust | Next Editor");
  });

  it("leaves the title to a child while its own title is null", () => {
    const { rerender } = render(<Titled title="@ada | Next Editor" />);
    expect(document.title).toBe("@ada | Next Editor");

    // The parent hands over in the commit that mounts the child, whose effect
    // runs first: had the parent kept a title, its effect would overwrite the child's.
    rerender(
      <Titled title={null}>
        <Titled title="Ada Lovelace | Next Editor" />
      </Titled>,
    );
    expect(document.title).toBe("Ada Lovelace | Next Editor");
  });

  it("matches the shell's static <title>", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const staticTitle = /<title>([^<]*)<\/title>/.exec(html)?.[1];
    expect(staticTitle?.replaceAll("&amp;", "&")).toBe(SITE_TITLE);
  });
});
