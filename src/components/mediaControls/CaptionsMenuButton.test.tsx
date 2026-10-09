import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import CaptionsMenuButton from "./CaptionsMenuButton";
import { CaptionStoreProvider } from "../../contexts/CaptionStoreContext";
import { useCaptionStore } from "../../hooks/useCaptionStore";
import type { CaptionTrack } from "../../core/src/types";

const english: CaptionTrack = { id: "en", language: "en", label: "English", cues: [] };
const french: CaptionTrack = { id: "fr", language: "fr", cues: [] };

const seen = { enabled: false, trackId: null as string | null, language: null as string | null };

function Player({ tracks }: { tracks: readonly CaptionTrack[] }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const captions = useCaptionStore();
  seen.enabled = captions.enabled;
  seen.trackId = captions.trackId;
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
    // One name in both states: aria-pressed says whether captions are on.
    const button = screen.getByRole("button", { name: "Captions", pressed: false });
    expect(button).not.toHaveAttribute("aria-haspopup");
    expect(button).toHaveClass("text-slate-500", "w-6");
    // Off shows a struck-through icon, not only a dimmer one.
    expect(button.querySelector(".lucide-captions-off")).not.toBeNull();

    fireEvent.click(button);
    expect(seen.enabled).toBe(true);
    expect(button).toHaveAccessibleName("Captions");
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveClass("text-white");
    expect(button.querySelector(".lucide-captions-off")).toBeNull();
    expect(button.querySelector(".lucide-captions")).not.toBeNull();
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

    // A track without a label goes by its language, named in full.
    const frenchItem = screen.getByRole("menuitemradio", { name: "French" });
    frenchItem.focus();
    fireEvent.click(frenchItem);
    expect(seen).toEqual({ enabled: true, trackId: "fr", language: "fr" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    // The chosen item went with the menu; focus is back on the button, not the page.
    expect(button).toHaveFocus();

    fireEvent.click(button);
    expect(screen.getByRole("menuitemradio", { name: "French" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "English" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("tells apart two tracks in the same language", () => {
    const generated: CaptionTrack = {
      id: "auto-en-1",
      language: "en",
      label: "Generated",
      cues: [],
    };
    renderPlayer([english, generated]);
    const button = screen.getByRole("button", { name: "Captions" });

    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Generated" }));
    expect(seen).toEqual({ enabled: true, trackId: "auto-en-1", language: "en" });

    fireEvent.click(button);
    expect(screen.getByRole("menuitemradio", { name: "Generated" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "English" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    fireEvent.click(screen.getByRole("menuitemradio", { name: "English" }));
    expect(seen.trackId).toBe("en");
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
    expect(button).toHaveFocus();
  });

  it("closes the menu on Escape, back on its button, without changing captions", () => {
    renderPlayer([english, french]);
    const button = screen.getByRole("button", { name: "Captions" });
    fireEvent.click(button);
    const englishItem = screen.getByRole("menuitemradio", { name: "English" });
    englishItem.focus();

    // fireEvent returns false once a handler has called preventDefault.
    expect(fireEvent.keyDown(englishItem, { key: "Escape" })).toBe(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
    expect(seen.enabled).toBe(false);
  });

  it("leaves other keys in the menu alone", () => {
    renderPlayer([english, french]);
    fireEvent.click(screen.getByRole("button", { name: "Captions" }));

    expect(fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" })).toBe(true);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});
