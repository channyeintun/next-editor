import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import AgentErrorNotice from "./AgentErrorNotice";

describe("AgentErrorNotice", () => {
  it("shows the error as an alert, line breaks included, with no Retry by default", () => {
    render(
      <AgentErrorNotice
        error={"Provider returned 500\nTry later"}
        canRetry={false}
        isRetryDisabled={false}
        onRetry={() => {}}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The agent hit an error");
    expect(alert.querySelector("pre")?.textContent).toBe("Provider returned 500\nTry later");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("retries when the failed run can be retried", () => {
    const onRetry = vi.fn<() => void>();
    render(<AgentErrorNotice error="boom" canRetry isRetryDisabled={false} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps Retry disabled when told to", () => {
    render(<AgentErrorNotice error="boom" canRetry isRetryDisabled onRetry={() => {}} />);

    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });
});
