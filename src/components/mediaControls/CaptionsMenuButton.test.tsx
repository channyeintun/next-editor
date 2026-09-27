import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import CaptionsMenuButton from "./CaptionsMenuButton";
import { CaptionStoreProvider } from "../../contexts/CaptionStoreContext";
import { useCaptionStore } from "../../hooks/useCaptionStore";
import type { CaptionTrack } from "../../core/src/types";

const english: CaptionTrack = { id: "en", language: "en", label: "English", cues: [] };
const french: CaptionTrack = { id: "fr", language: "fr", cues: [] };

const seen = { enabled: false, language: null as string | null };

function Player({ tracks }: { tracks: readonly CaptionTrack[] }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const captions = useCaptionStore();
  seen.enabled = captions.enabled;
  seen.language = captions.language;
  return (
    <CaptionsMenuButton
      tracks={tracks}
      menuOpen={menuOpen}
      setMenuOpen={setMenuOpen}
      iconSize={16}
      className="w-6"
    />
  );
}

const renderPlayer = (tracks: readonly CaptionTrack[]) =>
  render(
    <CaptionStoreProvider>
      <Player tracks={tracks} />
    </CaptionStoreProvider>,
  );

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("CaptionsMenuButton", () => {
  it("turns a lesson's only track on and off", () => {
    renderPlayer([english]);
    const button = screen.getByRole("button", { name: "Show captions" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).not.toHaveAttribute("aria-haspopup");
    expect(button).toHaveClass("text-slate-500", "w-6");

    fireEvent.click(button);
    expect(seen.enabled).toBe(true);
    expect(button).toHaveAttribute("title", "Hide captions");
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveClass("text-white");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("picks one of several tracks from a menu, which then closes", () => {
    renderPlayer([english, french]);
    const button = screen.getByRole("button", { name: "Captions" });
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).not.toHaveAttribute("aria-pressed");

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitemradio", { name: "Off" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // A track without a label goes by its language.
    fireEvent.click(screen.getByRole("menuitemradio", { name: "fr" }));
    expect(seen).toEqual({ enabled: true, language: "fr" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(screen.getByRole("menuitemradio", { name: "fr" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "English" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("turns captions off from the menu", () => {
    renderPlayer([english, french]);
    const button = screen.getByRole("button", { name: "Captions" });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "English" }));
    expect(seen.enabled).toBe(true);

    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Off" }));
    expect(seen.enabled).toBe(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
