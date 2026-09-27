import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import ToolConfirmationCard from "./ToolConfirmationCard";

const request = { toolName: "run_command", summary: "npm install\nnpm test" };

describe("ToolConfirmationCard", () => {
  it("names the tool and shows what it is about to run", () => {
    render(<ToolConfirmationCard request={request} onResolve={() => {}} />);

    expect(screen.getByText("Permission required")).toBeInTheDocument();
    expect(screen.getByText("Allow run_command to run this command?")).toBeInTheDocument();
    expect(document.querySelector("pre")?.textContent).toBe("npm install\nnpm test");
  });

  it("answers no on Deny and yes on Allow", () => {
    const onResolve = vi.fn<(approved: boolean) => void>();
    render(<ToolConfirmationCard request={request} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    expect(onResolve.mock.calls).toEqual([[false], [true]]);
  });
});
