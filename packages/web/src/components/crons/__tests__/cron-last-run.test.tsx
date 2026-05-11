import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CronLastRunIndicator } from "../cron-last-run-indicator";

describe("CronLastRunIndicator", () => {
  it("renders OK for success", () => {
    render(<CronLastRunIndicator status="success" durationMs={60_000} />);
    expect(screen.getByText(/OK/)).toBeTruthy();
  });

  it("renders BLOCKED with countdown when auto-resume scheduled", () => {
    render(
      <CronLastRunIndicator
        status="error"
        durationMs={3_000}
        errorKind="usage_cap"
        autoResumeScheduledAt={new Date(Date.now() + 60_000).toISOString()}
      />,
    );
    expect(screen.getByText(/BLOCKED/)).toBeTruthy();
    expect(screen.getByText(/auto-resume in/i)).toBeTruthy();
  });

  it("renders manual-resume label when error+recoverable but no auto-resume scheduled", () => {
    render(
      <CronLastRunIndicator status="error" durationMs={3_000} errorKind="usage_cap" autoResumeScheduledAt={null} />,
    );
    expect(screen.getByText(/manual resume required/i)).toBeTruthy();
  });

  it("renders investigate label for non-recoverable error", () => {
    render(<CronLastRunIndicator status="error" durationMs={3_000} errorKind="engine_crashed" />);
    expect(screen.getByText(/investigate/i)).toBeTruthy();
  });
});
