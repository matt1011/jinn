import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function makeSession(status: string, errorKind?: string, recoverable?: boolean) {
  return {
    id: `${status}-${errorKind ?? "ok"}`,
    engine: "codex",
    source: "web",
    sourceRef: "x",
    sessionKey: "x",
    connector: "web",
    status,
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastError: errorKind ? "err" : null,
    errorKind,
    errorRecoverable: recoverable,
    title: null,
    parentSessionId: null,
    messageId: null,
    model: null,
    employee: null,
  };
}

const listSpy = vi.fn(async () => [
  makeSession("idle"),
  makeSession("error", "usage_cap", true),
  makeSession("error", "engine_crashed", false),
]);

vi.mock("@/lib/api", () => ({
  api: {
    listSessions: () => listSpy(),
    deleteSession: vi.fn(async () => ({})),
    bulkDeleteSessions: vi.fn(async () => ({})),
  },
}));

vi.mock("@/app/settings-provider", () => ({
  useSettings: () => ({ settings: { portalName: "Jinn" } }),
}));

import { SessionList } from "../session-list";

function withProviders(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  localStorage.clear();
});

describe("SessionList — kind badges and recoverable filter", () => {
  it("renders an error badge for each error-state session", async () => {
    render(withProviders(<SessionList onSelect={() => {}} />));
    await waitFor(() => {
      const badges = document.querySelectorAll("[data-testid='session-error-badge']");
      expect(badges.length).toBe(2); // 2 error sessions
    });
  });

  it("filters to recoverable-only when filter chip is clicked", async () => {
    render(withProviders(<SessionList onSelect={() => {}} />));
    await waitFor(() => {
      const badges = document.querySelectorAll("[data-testid='session-error-badge']");
      expect(badges.length).toBe(2);
    });

    const filter = document.querySelector("[data-testid='filter-recoverable']") as HTMLElement;
    expect(filter).toBeTruthy();
    fireEvent.click(filter);

    await waitFor(() => {
      const badges = document.querySelectorAll("[data-testid='session-error-badge']");
      expect(badges.length).toBe(1);
      expect((badges[0] as HTMLElement).textContent?.toLowerCase()).toContain("usage");
    });
  });

  it("filter state persists in localStorage", async () => {
    const { unmount } = render(withProviders(<SessionList onSelect={() => {}} />));
    await waitFor(() => {
      expect(document.querySelectorAll("[data-testid='session-error-badge']").length).toBe(2);
    });
    fireEvent.click(document.querySelector("[data-testid='filter-recoverable']") as HTMLElement);
    expect(localStorage.getItem("sessions-recoverable-only")).toBe("1");
    unmount();

    // Re-mount — filter should remain active
    render(withProviders(<SessionList onSelect={() => {}} />));
    await waitFor(() => {
      const badges = document.querySelectorAll("[data-testid='session-error-badge']");
      expect(badges.length).toBe(1);
    });
  });
});
