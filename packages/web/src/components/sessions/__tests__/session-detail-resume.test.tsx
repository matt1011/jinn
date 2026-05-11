import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api", () => ({
  api: {
    getSessionChildren: vi.fn(async () => []),
    resumeSession: vi.fn(async () => ({})),
    cancelAutoResume: vi.fn(async () => ({})),
    resetSession: vi.fn(async () => ({})),
    stopSession: vi.fn(async () => ({})),
  },
}));

vi.mock("@/app/settings-provider", () => ({
  useSettings: () => ({ settings: { portalName: "Jinn" } }),
}));

import { SessionDetail } from "../session-detail";

function withProviders(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const baseSession = {
  id: "sess-1",
  engine: "codex",
  engineSessionId: null,
  source: "cron",
  sourceRef: "j",
  sessionKey: "j",
  connector: "cron",
  replyContext: null,
  status: "error" as const,
  transportState: "error" as const,
  queueDepth: 0,
  totalCost: 0,
  totalTurns: 0,
  createdAt: new Date().toISOString(),
  lastActivity: new Date().toISOString(),
  lastError: "hit your usage limit. try again at 7:10 AM",
  errorKind: "usage_cap" as const,
  errorRecoverable: true,
  errorRetryAfter: new Date(Date.now() + 60_000).toISOString(),
  title: null,
  parentSessionId: null,
  messageId: null,
  model: null,
  employee: null,
};

describe("SessionDetail — error chip + modal", () => {
  it("shows an error chip when errorKind is set and recoverable", () => {
    const { container } = render(
      withProviders(<SessionDetail session={baseSession as never} onClose={() => {}} />),
    );
    const chip = container.querySelector("[data-testid='error-chip']");
    expect(chip).toBeTruthy();
  });

  it("opens the ResumeModal when the chip is clicked", () => {
    const { container } = render(
      withProviders(<SessionDetail session={baseSession as never} onClose={() => {}} />),
    );
    const chip = container.querySelector("[data-testid='error-chip']") as HTMLElement;
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
    const dialog = document.querySelector("[role='dialog']");
    expect(dialog).toBeTruthy();
  });

  it("does not show the chip when errorKind is unset", () => {
    const okSession = {
      ...baseSession,
      status: "idle" as const,
      transportState: "idle" as const,
      lastError: null,
      errorKind: undefined,
      errorRecoverable: undefined,
    };
    const { container } = render(
      withProviders(<SessionDetail session={okSession as never} onClose={() => {}} />),
    );
    expect(container.querySelector("[data-testid='error-chip']")).toBeNull();
  });

  it("does not show the chip when errorKind is set but not recoverable", () => {
    const crashedSession = {
      ...baseSession,
      errorKind: "engine_crashed" as const,
      errorRecoverable: false,
    };
    const { container } = render(
      withProviders(<SessionDetail session={crashedSession as never} onClose={() => {}} />),
    );
    expect(container.querySelector("[data-testid='error-chip']")).toBeNull();
  });
});
