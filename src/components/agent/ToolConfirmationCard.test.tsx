import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import ToolConfirmationCard from "./ToolConfirmationCard";

const request = { toolName: "run_command", summary: "npm install\nnpm test" };

describe("ToolConfirmationCard", () => {
  it("names the tool and shows what it is about to run", () => {
    render(<ToolConfirmationCard request={request} onResolve={() => {}} />);

    expect(screen.getByText("Permission required")).toBeInTheDocument();
    expect(screen.getByText("Allow run_command to run this command?")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Command to approve" }).textContent).toBe(
      "npm install\nnpm test",
    );
  });

  it("lets the keyboard reach the command so a long one can be scrolled", () => {
    render(<ToolConfirmationCard request={request} onResolve={() => {}} />);

    const command = screen.getByRole("region", { name: "Command to approve" });
    expect(command).toHaveAttribute("tabindex", "0");
    command.focus();
    expect(command).toHaveFocus();
  });

  it("is announced as an alert when it appears", () => {
    render(<ToolConfirmationCard request={request} onResolve={() => {}} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Permission required");
    expect(alert).toHaveTextContent("Allow run_command to run this command?");
  });

  it("answers no on Deny and yes on Allow", () => {
    const onResolve = vi.fn<(approved: boolean) => void>();
    render(<ToolConfirmationCard request={request} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    expect(onResolve.mock.calls).toEqual([[false], [true]]);
  });
});
