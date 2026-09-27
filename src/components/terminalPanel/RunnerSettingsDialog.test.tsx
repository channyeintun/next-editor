import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { RunnerConfig } from "../../contexts/WebContainerRuntimeContext";
import RunnerSettingsDialog from "./RunnerSettingsDialog";

const runnerConfig: RunnerConfig = {
  enabled: true,
  runOnStartup: false,
  runOnFileSave: true,
  initCommand: "pnpm install",
  runCommand: "pnpm dev",
};

function renderDialog(isReadOnly = false) {
  const onChange = vi.fn<(config: Partial<RunnerConfig>) => void>();
  const onClose = vi.fn<() => void>();
  const view = render(
    <RunnerSettingsDialog
      runnerConfig={runnerConfig}
      isReadOnly={isReadOnly}
      onChange={onChange}
      onClose={onClose}
    />,
  );
  return { ...view, onChange, onClose, backdrop: view.container.firstElementChild! };
}

describe("RunnerSettingsDialog", () => {
  it("shows the runner settings", () => {
    renderDialog();

    expect(screen.getByRole("switch", { name: /^Enable Runner/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("switch", { name: /^Run on startup/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("switch", { name: /^Run on file-save/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("textbox", { name: /^Init Command/ })).toHaveValue("pnpm install");
    expect(screen.getByRole("textbox", { name: /^Run Command/ })).toHaveValue("pnpm dev");
  });

  it("reports each change as the one setting it changes", () => {
    const { onChange } = renderDialog();

    fireEvent.click(screen.getByRole("switch", { name: /^Enable Runner/ }));
    fireEvent.click(screen.getByRole("switch", { name: /^Run on startup/ }));
    fireEvent.click(screen.getByRole("switch", { name: /^Run on file-save/ }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Init Command/ }), {
      target: { value: "npm ci" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /^Run Command/ }), {
      target: { value: "npm start" },
    });

    expect(onChange.mock.calls).toEqual([
      [{ enabled: false }],
      [{ runOnStartup: true }],
      [{ runOnFileSave: false }],
      [{ initCommand: "npm ci" }],
      [{ runCommand: "npm start" }],
    ]);
  });

  it("closes on a backdrop click", () => {
    const { backdrop, onClose } = renderDialog();

    fireEvent.click(screen.getByRole("textbox", { name: /^Run Command/ }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("while a recording plays back, locks every control and stays open", () => {
    const { backdrop, onClose } = renderDialog(true);

    for (const control of [...screen.getAllByRole("switch"), ...screen.getAllByRole("textbox")]) {
      expect(control).toBeDisabled();
    }

    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });
});
