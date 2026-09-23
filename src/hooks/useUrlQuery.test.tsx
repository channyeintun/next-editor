import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, useSearchParams } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { UrlLoader } from "./useUrlLoader";
import { useUrlQuery } from "./useUrlQuery";

function fakeLoader() {
  const fetchNextEditorFile = vi.fn<UrlLoader["fetchNextEditorFile"]>(async () => {});
  return { loader: { fetchNextEditorFile } as unknown as UrlLoader, fetchNextEditorFile };
}

function inRouterAt(entry: string) {
  return ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, { initialEntries: [entry] }, children);
}

describe("useUrlQuery", () => {
  it("does not reload the lesson when another query param changes", () => {
    const { loader, fetchNextEditorFile } = fakeLoader();
    const { result } = renderHook(
      () => {
        useUrlQuery(loader);
        return useSearchParams()[1];
      },
      { wrapper: inRouterAt("/code?url=https://example.com/a.ne") },
    );
    expect(fetchNextEditorFile).toHaveBeenCalledTimes(1);

    // What CollaborationContext does when a live room is started, joined or left.
    act(() => {
      result.current((current) => {
        const next = new URLSearchParams(current);
        next.set("room", "room-1");
        return next;
      });
    });

    expect(fetchNextEditorFile).toHaveBeenCalledTimes(1);
  });

  it("loads the new lesson when the url param changes", () => {
    const { loader, fetchNextEditorFile } = fakeLoader();
    const { result } = renderHook(
      () => {
        useUrlQuery(loader);
        return useSearchParams()[1];
      },
      { wrapper: inRouterAt("/code?url=https://example.com/a.ne") },
    );

    act(() => {
      result.current({ url: "https://example.com/b.ne" });
    });

    expect(fetchNextEditorFile.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/a.ne",
      "https://example.com/b.ne",
    ]);
  });

  it("prefers the override URL to the query param", () => {
    const { loader, fetchNextEditorFile } = fakeLoader();
    renderHook(() => useUrlQuery(loader, "/lessons/b.ne"), {
      wrapper: inRouterAt("/code?url=https://example.com/a.ne"),
    });

    expect(fetchNextEditorFile).toHaveBeenCalledWith(`${window.location.origin}/lessons/b.ne`);
  });
});
