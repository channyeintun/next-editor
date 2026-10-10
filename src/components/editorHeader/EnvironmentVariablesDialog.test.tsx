import { fireEvent, render, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  WebContainerRuntimeActionsContext,
  WebContainerRuntimeMetadataContext,
  type WebContainerRuntimeActions,
  type WebContainerRuntimeMetadata,
} from "../../contexts/WebContainerRuntimeContext";
import type {
  EnvironmentVariables,
  WebContainerRuntimeStatus,
} from "../../runtime/webcontainer/types";
import EnvironmentVariablesDialog, {
  parseEnvironmentInput,
  stringifyEnvironmentVariables,
} from "./EnvironmentVariablesDialog";

describe("stringifyEnvironmentVariables", () => {
  it("writes one KEY=value line per variable, sorted by key", () => {
    expect(stringifyEnvironmentVariables({ NODE_ENV: "development", API_URL: "https://a.b" })).toBe(
      "API_URL=https://a.b\nNODE_ENV=development",
    );
    expect(stringifyEnvironmentVariables({})).toBe("");
  });
});

describe("parseEnvironmentInput", () => {
  it("reads KEY=value lines, skipping blank lines and comments", () => {
    expect(
      parseEnvironmentInput("# the API\r\nAPI_URL=https://a.b/?x=1\n\n   \n  PORT = 3000 \n"),
    ).toEqual({
      environmentVariables: { API_URL: "https://a.b/?x=1", PORT: " 3000 " },
      errorMessage: null,
    });
  });

  it("rejects the whole input at the first malformed line", () => {
    expect(parseEnvironmentInput("A=1\nno separator\n1BAD=2")).toEqual({
      environmentVariables: {},
      errorMessage: "Line 2 must use KEY=value format.",
    });
    expect(parseEnvironmentInput("=value")).toEqual({
      environmentVariables: {},
      errorMessage: "Line 1 must use KEY=value format.",
    });
    expect(parseEnvironmentInput("A=1\n1BAD=2")).toEqual({
      environmentVariables: {},
      errorMessage: "Line 2 has an invalid variable name.",
    });
  });
});

interface RenderOptions {
  environmentVariables?: EnvironmentVariables;
  runnerEnabled?: boolean;
  status?: WebContainerRuntimeStatus;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

function renderDialog({
  environmentVariables = { NODE_ENV: "development", API_URL: "https://example.com" },
  runnerEnabled = true,
  status = "ready",
  returnFocusRef,
}: RenderOptions = {}) {
  const actions = {
    rerunRunner: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    updateEnvironmentVariables: vi.fn<(variables: EnvironmentVariables) => void>(),
  };
  const onClose = vi.fn<() => void>();
  const dialog = (variables: EnvironmentVariables) => (
    <WebContainerRuntimeActionsContext value={actions as unknown as WebContainerRuntimeActions}>
      <WebContainerRuntimeMetadataContext
        value={
          {
            environmentVariables: variables,
            runnerConfig: { enabled: runnerEnabled },
            status,
          } as unknown as WebContainerRuntimeMetadata
        }
      >
        <EnvironmentVariablesDialog onClose={onClose} returnFocusRef={returnFocusRef} />
      </WebContainerRuntimeMetadataContext>
    </WebContainerRuntimeActionsContext>
  );
  const view = render(dialog(environmentVariables));
  return {
    ...view,
    actions,
    onClose,
    textarea: () => screen.getByLabelText("Environment variables"),
    rerenderWithVariables: (variables: EnvironmentVariables) => view.rerender(dialog(variables)),
  };
}

describe("EnvironmentVariablesDialog", () => {
  it("starts from the current variables", () => {
    const { textarea } = renderDialog();

    expect(textarea()).toHaveValue("API_URL=https://example.com\nNODE_ENV=development");
  });

  it("saves the edited variables, closes, and reruns an enabled runner that is not busy", () => {
    const { actions, onClose, textarea } = renderDialog();

    fireEvent.change(textarea(), { target: { value: "DEBUG=1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(actions.updateEnvironmentVariables).toHaveBeenCalledWith({ DEBUG: "1" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(actions.rerunRunner).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["disabled", { runnerEnabled: false }],
    ["busy", { status: "installing" as const }],
  ])("saves without rerunning a %s runner", (_, options) => {
    const { actions, onClose } = renderDialog(options);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(actions.updateEnvironmentVariables).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(actions.rerunRunner).not.toHaveBeenCalled();
  });

  it("shows a malformed line instead of saving, until the next edit", () => {
    const { actions, onClose, textarea } = renderDialog();

    expect(textarea()).not.toHaveAttribute("aria-invalid");
    expect(textarea()).not.toHaveAttribute("aria-describedby");

    fireEvent.change(textarea(), { target: { value: "not a variable" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Announced as an alert, since focus stays on Save, and tied to the field.
    expect(screen.getByRole("alert")).toHaveTextContent("Line 1 must use KEY=value format.");
    expect(textarea()).toHaveAttribute("aria-invalid", "true");
    expect(textarea()).toHaveAccessibleDescription("Line 1 must use KEY=value format.");
    expect(actions.updateEnvironmentVariables).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.change(textarea(), { target: { value: "NOW=valid" } });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(textarea()).not.toHaveAttribute("aria-invalid");
    expect(textarea()).not.toHaveAttribute("aria-describedby");
  });

  it("shows a two-line example as the placeholder", () => {
    const { textarea } = renderDialog({ environmentVariables: {} });

    expect(textarea()).toHaveAttribute(
      "placeholder",
      "API_URL=https://example.com\nNODE_ENV=development",
    );
    expect(textarea().getAttribute("placeholder")).not.toContain("\\n");
  });

  it("is a modal dialog titled Edit Environment that starts in the text area", () => {
    const { textarea } = renderDialog();

    expect(screen.getByRole("dialog", { name: "Edit Environment" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(textarea()).toHaveFocus();
  });

  it("closes without saving on Cancel, a backdrop click, or Escape", () => {
    const { actions, onClose, container, textarea } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(container.firstElementChild!);
    fireEvent.keyDown(textarea(), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(3);
    expect(actions.updateEnvironmentVariables).not.toHaveBeenCalled();
  });

  it("gives focus to returnFocusRef when it closes", () => {
    const settingsButton = document.createElement("button");
    document.body.append(settingsButton);
    const { unmount } = renderDialog({ returnFocusRef: { current: settingsButton } });

    unmount();

    expect(settingsButton).toHaveFocus();
    settingsButton.remove();
  });

  it("replaces the draft and any error when the variables change while it is open", () => {
    const { textarea, rerenderWithVariables } = renderDialog();

    fireEvent.change(textarea(), { target: { value: "half typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    rerenderWithVariables({ PORT: "4000" });

    expect(textarea()).toHaveValue("PORT=4000");
    expect(screen.queryByText("Line 1 must use KEY=value format.")).not.toBeInTheDocument();
  });
});
