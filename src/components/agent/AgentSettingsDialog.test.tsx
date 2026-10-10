import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getAgentStore } from "../../agent/agentStore";
import { getAgentCredentialStore } from "../../agent/credentials";
import type { AgentModelOption } from "../../agent/modelCatalog";
import AgentSettingsDialog from "./AgentSettingsDialog";
import type { OpenRouterModelCatalog } from "./useOpenRouterModelCatalog";

const textModel: AgentModelOption = {
  id: "vendor/text-only",
  label: "Vendor: Text Only",
  supportsImages: false,
};
const visionModel: AgentModelOption = {
  id: "vendor/vision",
  label: "Vendor: Vision",
  supportsImages: true,
};
const loadedCatalog: OpenRouterModelCatalog = {
  modelOptions: [textModel, visionModel],
  isModelCatalogLoading: false,
  modelCatalogError: null,
};

/** Holds the search text and key draft the way AgentPanel does. */
function Dialog({
  catalog = loadedCatalog,
  onClose = () => {},
}: {
  catalog?: OpenRouterModelCatalog;
  onClose?: () => void;
}) {
  const [modelQuery, setModelQuery] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  return (
    <AgentSettingsDialog
      modelCatalog={catalog}
      modelQuery={modelQuery}
      onModelQueryChange={setModelQuery}
      keyDraft={keyDraft}
      onKeyDraftChange={setKeyDraft}
      onClose={onClose}
    />
  );
}

afterEach(() => {
  const credentialStore = getAgentCredentialStore();
  credentialStore.trigger.clear();
  credentialStore.trigger.setStorage({ storage: "memory" });
  getAgentStore().trigger.reset();
});

describe("AgentSettingsDialog", () => {
  it("lists the models, marks the chosen one, and sets the one picked", () => {
    act(() => getAgentStore().trigger.setModel({ model: visionModel.id }));
    render(<Dialog />);

    const modelGroup = screen.getByRole("group", { name: "Model" });
    expect(within(modelGroup).getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByLabelText(/Vendor: Vision/)).toBeChecked();
    expect(screen.getByLabelText(/Vendor: Text Only/)).not.toBeChecked();
    expect(screen.getByText("vendor/text-only · no image input")).toBeInTheDocument();
    expect(screen.getByText("2 models from OpenRouter.")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Vendor: Text Only/));

    expect(getAgentStore().getSnapshot().context.model).toBe(textModel.id);
    expect(screen.getByLabelText(/Vendor: Text Only/)).toBeChecked();
  });

  it("filters the models by the search text", () => {
    render(<Dialog />);
    const search = screen.getByLabelText("Search OpenRouter models");
    const modelRadios = () => document.querySelectorAll('input[name="agent-model"]');

    fireEvent.change(search, { target: { value: "VISION" } });
    expect(modelRadios()).toHaveLength(1);
    expect(screen.getByLabelText(/Vendor: Vision/)).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "  nothing " } });
    expect(modelRadios()).toHaveLength(0);
    expect(screen.getByText("No models match “nothing”.")).toBeInTheDocument();
  });

  it("announces how many models the search text matches", () => {
    render(<Dialog />);
    const search = screen.getByLabelText("Search OpenRouter models");
    // The filter status is mounted empty before the first keystroke, so a
    // screen reader hears every change to it.
    const filterStatus = screen.getAllByRole("status").find((region) => region.textContent === "");
    expect(filterStatus).toBeDefined();

    fireEvent.change(search, { target: { value: "vendor" } });
    expect(filterStatus).toHaveTextContent("2 models match");

    fireEvent.change(search, { target: { value: "VISION" } });
    expect(filterStatus).toHaveTextContent("1 model matches");

    fireEvent.change(search, { target: { value: "  nothing " } });
    expect(filterStatus).toHaveTextContent("No models match nothing");

    fireEvent.change(search, { target: { value: "" } });
    expect(filterStatus).toBeEmptyDOMElement();
  });

  it("says when the list is loading or why it fell back, and shows this session's usage", () => {
    act(() => getAgentStore().trigger.addUsage({ usage: { inputTokens: 1200, outputTokens: 34 } }));
    const { rerender } = render(
      <Dialog catalog={{ ...loadedCatalog, isModelCatalogLoading: true }} />,
    );
    const catalogStatus = screen.getByText("Loading models from OpenRouter…");
    expect(catalogStatus).toHaveAttribute("role", "status");
    expect(screen.getByText("Usage this session: 1200 in / 34 out tokens.")).toBeInTheDocument();

    rerender(<Dialog catalog={{ ...loadedCatalog, modelCatalogError: "Offline; fallbacks." }} />);
    // The same live region now carries the failure, so it is announced.
    expect(catalogStatus).toHaveTextContent("Offline; fallbacks.");
  });

  it("saves the trimmed key, empties the field, and clears a saved key", () => {
    render(<Dialog />);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();

    const keyInput = screen.getByLabelText("API key");
    expect(keyInput).toHaveAttribute("placeholder", "sk-or-v1-...");
    expect(keyInput).toHaveAttribute("autocomplete", "off");
    expect(keyInput).not.toHaveAccessibleDescription();
    fireEvent.change(keyInput, { target: { value: "  sk-or-v1-secret  " } });
    fireEvent.click(save);

    expect(getAgentCredentialStore().getSnapshot().context.apiKey).toBe("sk-or-v1-secret");
    expect(keyInput).toHaveValue("");
    expect(keyInput).toHaveAttribute("placeholder", "•••• (set) — paste to replace");
    expect(keyInput).toHaveAccessibleDescription("A key is saved. Paste a new one to replace it.");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(getAgentCredentialStore().getSnapshot().context.apiKey).toBe("");
    expect(keyInput).not.toHaveAccessibleDescription();
  });

  it("keeps focus on the key field after Save and Clear", () => {
    render(<Dialog />);
    const keyInput = screen.getByLabelText("API key");

    fireEvent.change(keyInput, { target: { value: "sk-or-v1-secret" } });
    const save = screen.getByRole("button", { name: "Save" });
    save.focus();
    fireEvent.click(save);
    expect(save).toBeDisabled();
    expect(keyInput).toHaveFocus();

    const clear = screen.getByRole("button", { name: "Clear" });
    clear.focus();
    fireEvent.click(clear);
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    expect(keyInput).toHaveFocus();
  });

  it("remembers the key where the user chooses", () => {
    render(<Dialog />);
    const storageGroup = screen.getByRole("group", { name: "Remember key" });
    expect(within(storageGroup).getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByLabelText(/Memory only/)).toBeChecked();

    fireEvent.click(screen.getByLabelText(/This tab/));

    expect(getAgentCredentialStore().getSnapshot().context.storage).toBe("session");
    expect(screen.getByLabelText(/This tab/)).toBeChecked();
  });

  it("is a modal dialog titled Agent settings that starts on its Close button", () => {
    render(<Dialog />);

    expect(screen.getByRole("dialog", { name: "Agent settings" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(screen.getByRole("heading", { level: 2, name: "Agent settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close settings" })).toHaveFocus();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn<() => void>();
    render(<Dialog onClose={onClose} />);

    fireEvent.keyDown(screen.getByLabelText("Search OpenRouter models"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from the backdrop and the close button, not from a click inside", () => {
    const onClose = vi.fn<() => void>();
    render(<Dialog onClose={onClose} />);

    fireEvent.click(screen.getByText("Agent settings"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    fireEvent.mouseDown(screen.getByText("Agent settings").closest(".fixed")!);
    fireEvent.click(screen.getByText("Agent settings").closest(".fixed")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
